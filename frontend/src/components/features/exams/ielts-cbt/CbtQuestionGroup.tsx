'use client';

import React, { useMemo } from 'react';
import type { PublicGroupDto, PublicItemDto } from '@/types/exams';
import {
  cbtChoice,
  cbtOptionText,
  cbtOptions,
  cbtPrompt,
  cbtText,
  groupHeading,
  isClosedTruthSet,
  type CbtOption,
} from '@/lib/exams/ieltsCbt';
import { distributeSelection, parseCompletionTemplate, selectedFromResponses, toggleChooseN } from '@/lib/exams/groupPresentation';
import { isImageAsset } from '@/lib/exams/media';
import { ExamAssetImage } from '../ExamAssetImage';
import s from './ieltsCbt.module.css';

/**
 * IELTS CBT question group renderer (2026-11-13). One printed group = heading "Questions a–b", the group's own printed
 * instructions (bold capitals as printed), then the interaction per question through the registry below. Nothing is
 * invented: no instruction text, option or blank exists unless the exam data carries it. Answer values are stored
 * exactly as the existing runtime stores them (one option id, one text, a choose-N set spread one id per member), so
 * autosave, scoring and review are unchanged.
 */

export interface CbtGroupProps {
  group: PublicGroupDto;
  numberOf: (item: PublicItemDto) => number;
  responses: Record<string, any>;
  onAnswer: (placementId: string, value: any) => void;
  activePlacementId?: string;
  onSelect: (placementId: string) => void;
  disabled?: boolean;
  attemptId?: string;
  /** Show the group's figures (Listening has no passage pane; Reading label-assignment groups). */
  showFigures?: boolean;
}

const TEXT_ENTRY = (t: string) => t.includes('GAP') || t.includes('ENTRY') || t.includes('BLANK') || t.includes('SHORT');
const typeOf = (item: PublicItemDto) => (item.interactionType || '').toUpperCase();

/** Bold the printed capitals of an instruction ("Choose TRUE if …", "Write ONE WORD AND/OR A NUMBER …"). */
export function emphasiseCapitals(line: string): React.ReactNode {
  const re = /\b[A-Z]{2,}[A-Z/]*(?:\s+(?:[A-Z]{1,}[A-Z/]*))*\b/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(<b key={k++}>{m[0]}</b>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function QNum({ n, active, onClick }: { n: number | string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={s.qNum} data-active={active} onClick={onClick} aria-label={`Question ${n}`} tabIndex={-1}>
      {n}
    </button>
  );
}

/** Text input showing the printed number until the candidate types (reference gap behaviour). */
function Gap({
  item,
  n,
  value,
  onAnswer,
  onSelect,
  active,
  disabled,
}: {
  item: PublicItemDto;
  n: number;
  value: any;
  onAnswer: (pid: string, v: any) => void;
  onSelect: (pid: string) => void;
  active: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      className={s.gap}
      data-active={active}
      data-question={n}
      id={`cbt-input-${item.placementId}`}
      value={cbtText(value)}
      placeholder={String(n)}
      aria-label={`Question ${n}`}
      maxLength={500}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      disabled={disabled}
      onFocus={() => onSelect(item.placementId)}
      onChange={(e) => onAnswer(item.placementId, e.target.value)}
    />
  );
}

/** Splits a prompt at its first printed blank ("____", "……", "(3) ____"). */
function splitAtBlank(prompt: string): [string, string] | null {
  const m = /(\(\d{1,3}\)\s*)?(?:_{2,}|…{1,}|\.{4,})/.exec(prompt);
  if (!m) return null;
  return [prompt.slice(0, m.index), prompt.slice(m.index + m[0].length)];
}

function ChoiceList({
  item,
  options,
  value,
  onAnswer,
  onSelect,
  disabled,
  showKeys,
}: {
  item: PublicItemDto;
  options: CbtOption[];
  value: any;
  onAnswer: (pid: string, v: any) => void;
  onSelect: (pid: string) => void;
  disabled?: boolean;
  showKeys: boolean;
}) {
  const current = cbtChoice(value);
  const name = `cbt-${item.placementId}`;
  return (
    <div className={s.choices} role="radiogroup" aria-labelledby={`cbt-stem-${item.placementId}`}>
      {options.map((opt) => {
        const selected = current !== '' && current.toUpperCase() === opt.id.toUpperCase();
        return (
          <label key={opt.id} className={s.choice} data-selected={selected} data-disabled={!!disabled}>
            <input
              type="radio"
              name={name}
              value={opt.id}
              checked={selected}
              disabled={disabled}
              onChange={() => {
                onSelect(item.placementId);
                onAnswer(item.placementId, opt.id);
              }}
            />
            {showKeys && opt.text && opt.text !== opt.id ? <span className={s.choiceKey}>{opt.id}</span> : null}
            {showKeys ? cbtOptionText(opt) : opt.text || opt.id}
          </label>
        );
      })}
    </div>
  );
}

function MultiList({
  item,
  options,
  value,
  onAnswer,
  onSelect,
  disabled,
}: {
  item: PublicItemDto;
  options: CbtOption[];
  value: any;
  onAnswer: (pid: string, v: any) => void;
  onSelect: (pid: string) => void;
  disabled?: boolean;
}) {
  const list: string[] = Array.isArray(value)
    ? value.map(String)
    : Array.isArray(value?.selectedChoices)
    ? value.selectedChoices.map(String)
    : Array.isArray(value?.values)
    ? value.values.map(String)
    : [];
  const limit = item.cardinality > 1 ? item.cardinality : options.length;
  return (
    <div className={s.choices} role="group" aria-labelledby={`cbt-stem-${item.placementId}`}>
      {options.map((opt) => {
        const checked = list.includes(opt.id);
        const atLimit = !checked && list.length >= limit;
        return (
          <label key={opt.id} className={s.choice} data-selected={checked} data-disabled={!!disabled || atLimit}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled || atLimit}
              onChange={() => {
                onSelect(item.placementId);
                onAnswer(item.placementId, checked ? list.filter((x) => x !== opt.id) : [...list, opt.id]);
              }}
            />
            {cbtOptionText(opt)}
          </label>
        );
      })}
    </div>
  );
}

function stimuliImages(group: PublicGroupDto) {
  return (group.stimuli || []).flatMap((st) =>
    (st.assets || [])
      .filter((a) => isImageAsset(a) && a.delivery === 'PLAYBACK_GRANT' && a.assetId)
      .map((a) => ({ asset: a, alt: (st.bodyPayload as any)?.altText || st.title || 'Figure' }))
  );
}

export function CbtQuestionGroup({
  group,
  numberOf,
  responses,
  onAnswer,
  activePlacementId,
  onSelect,
  disabled,
  attemptId,
  showFigures = false,
}: CbtGroupProps) {
  const p = group.presentation || {};
  const items = group.items || [];
  const numbers = items.map(numberOf);
  const heading = groupHeading(numbers, p.questions);
  const instructions = Array.isArray(p.instructions) ? p.instructions.filter((l) => String(l || '').trim()) : [];
  const wordRuleShown =
    !!p.wordLimitRule && !instructions.some((l) => l.toUpperCase().includes(String(p.wordLimitRule).toUpperCase()));

  const template = useMemo(
    () => (p.stem && items.length > 0 && items.every((it) => TEXT_ENTRY(typeOf(it))) ? parseCompletionTemplate(p.stem, numbers) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.stem, items]
  );
  const byNumber = new Map(items.map((it, i) => [numbers[i], it]));

  const selection = p.selection && p.selection.count > 1 ? p.selection : null;
  const selectionMembers = useMemo(() => {
    if (!selection) return [] as PublicItemDto[];
    const wanted = new Set(selection.questions || []);
    return items.filter((it) => wanted.has(numberOf(it))).sort((a, b) => numberOf(a) - numberOf(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, items]);
  const chooseN = selection && selectionMembers.length === selection.count ? selection : null;

  // Matching features / label assignment over one shared option pool ⇒ the reference option matrix.
  const matrixType = items.length > 1 && items.every((it) => ['MATCHING', 'LABEL_ASSIGNMENT'].includes(typeOf(it)));
  const sharedOptions = matrixType ? cbtOptions(items[0]) : [];
  const matrix =
    matrixType &&
    sharedOptions.length > 1 &&
    sharedOptions.length <= 12 &&
    items.every((it) => cbtOptions(it).map((o) => o.id).join('|') === sharedOptions.map((o) => o.id).join('|'));

  const headingType = items.some((it) => typeOf(it) === 'HEADING_MATCHING');
  const headingList = headingType ? cbtOptions(items.find((it) => typeOf(it) === 'HEADING_MATCHING')) : [];
  const figures = showFigures || items.some((it) => typeOf(it) === 'LABEL_ASSIGNMENT') ? stimuliImages(group) : [];

  const renderChooseN = () => {
    if (!chooseN) return null;
    const first = selectionMembers[0];
    const options = cbtOptions(first);
    const order = options.map((o) => o.id);
    const selected = selectedFromResponses(selectionMembers.map((m) => responses[m.placementId]), order);
    const label = selectionMembers.map(numberOf).join('–').replace(/^(\d+)–.*–(\d+)$/, '$1–$2');
    const active = selectionMembers.some((m) => m.placementId === activePlacementId);
    return (
      <div className={s.question} id={`item-${first.placementId}`} data-cbt-question={first.placementId}>
        <div className={s.questionStem}>
          <QNum n={label} active={active} onClick={() => onSelect(first.placementId)} />
          <span className={s.qText} id={`cbt-stem-${first.placementId}`}>
            {emphasiseCapitals(cbtPrompt(first.prompt))}
          </span>
        </div>
        <div className={s.choices} role="group" aria-labelledby={`cbt-stem-${first.placementId}`} data-capability="CHOOSE_N_SELECTION">
          {options.map((opt) => {
            const checked = selected.includes(opt.id);
            const atLimit = !checked && selected.length >= chooseN.count;
            return (
              <label key={opt.id} className={s.choice} data-selected={checked} data-disabled={!!disabled || atLimit}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || atLimit}
                  onChange={() => {
                    const r = toggleChooseN(selected, opt.id, chooseN.count);
                    if (r.rejected) return;
                    const stored = distributeSelection(r.selected, order, selectionMembers.length);
                    onSelect(first.placementId);
                    selectionMembers.forEach((m, i) => {
                      if (cbtChoice(responses[m.placementId]) !== stored[i]) onAnswer(m.placementId, stored[i]);
                    });
                  }}
                />
                {cbtOptionText(opt)}
              </label>
            );
          })}
        </div>
      </div>
    );
  };

  const renderTemplate = () => {
    if (!template || !template.complete) return null;
    return (
      <div data-capability="COMPLETION_TEMPLATE">
        {template.lines.map((segments, li) => {
          if (segments.length === 0) return <div key={li} className={s.templateLine} aria-hidden />;
          return (
            <p key={li} className={s.templateLine}>
              {segments.map((seg, si) => {
                if (seg.type === 'text') return <React.Fragment key={si}>{seg.text}</React.Fragment>;
                const it = byNumber.get(seg.number);
                if (!it) return null;
                return (
                  <span key={si} id={`item-${it.placementId}`} data-cbt-question={it.placementId}>
                    <Gap
                      item={it}
                      n={seg.number}
                      value={responses[it.placementId]}
                      onAnswer={onAnswer}
                      onSelect={onSelect}
                      active={activePlacementId === it.placementId}
                      disabled={disabled}
                    />
                  </span>
                );
              })}
            </p>
          );
        })}
      </div>
    );
  };

  const renderMatrix = () => {
    if (!matrix) return null;
    return (
      <div className={s.question} data-capability="MATCHING_MATRIX">
        <table className={s.matrix} aria-label="Table of options to match">
          <thead>
            <tr>
              <th />
              {sharedOptions.map((o) => (
                <th key={o.id} scope="col">
                  {o.id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const current = cbtChoice(responses[it.placementId]);
              const n = numbers[i];
              return (
                <tr key={it.placementId} id={`item-${it.placementId}`} data-cbt-question={it.placementId} data-active={activePlacementId === it.placementId}>
                  <th scope="row">
                    <span className={s.matrixRow}>
                      <QNum n={n} active={activePlacementId === it.placementId} onClick={() => onSelect(it.placementId)} />
                      <span>{cbtPrompt(it.prompt)}</span>
                    </span>
                  </th>
                  {sharedOptions.map((o) => (
                    <td key={o.id}>
                      <input
                        type="radio"
                        name={`cbt-${it.placementId}`}
                        aria-label={`Question ${n}: ${o.id}`}
                        checked={current.toUpperCase() === o.id.toUpperCase()}
                        disabled={disabled}
                        onChange={() => {
                          onSelect(it.placementId);
                          onAnswer(it.placementId, o.id);
                        }}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderItem = (item: PublicItemDto, i: number) => {
    const t = typeOf(item);
    const n = numbers[i];
    const active = activePlacementId === item.placementId;
    const prompt = cbtPrompt(item.prompt);
    const value = responses[item.placementId];
    const common = { id: `item-${item.placementId}`, 'data-cbt-question': item.placementId, className: s.question };

    if (TEXT_ENTRY(t)) {
      const split = splitAtBlank(prompt);
      const gap = <Gap item={item} n={n} value={value} onAnswer={onAnswer} onSelect={onSelect} active={active} disabled={disabled} />;
      if (split) {
        return (
          <p key={item.placementId} {...common}>
            {split[0]}
            {gap}
            {split[1]}
          </p>
        );
      }
      return (
        <div key={item.placementId} {...common}>
          {prompt && (
            <div className={s.questionStem}>
              <QNum n={n} active={active} onClick={() => onSelect(item.placementId)} />
              <span className={s.qText} id={`cbt-stem-${item.placementId}`}>{prompt}</span>
            </div>
          )}
          {gap}
        </div>
      );
    }

    const options = cbtOptions(item);
    const stem = (
      <div className={s.questionStem}>
        <QNum n={n} active={active} onClick={() => onSelect(item.placementId)} />
        <span className={s.qText} id={`cbt-stem-${item.placementId}`}>
          {prompt}
        </span>
      </div>
    );

    if (t === 'MULTIPLE_CHOICE_MULTI') {
      return (
        <div key={item.placementId} {...common}>
          {stem}
          <MultiList item={item} options={options} value={value} onAnswer={onAnswer} onSelect={onSelect} disabled={disabled} />
        </div>
      );
    }

    if (t === 'HEADING_MATCHING' || t === 'MATCHING' || t === 'LABEL_ASSIGNMENT') {
      const current = cbtChoice(value);
      return (
        <div key={item.placementId} {...common}>
          <div className={s.questionStem}>
            <QNum n={n} active={active} onClick={() => onSelect(item.placementId)} />
            <span className={s.qText}>
              <label htmlFor={`cbt-input-${item.placementId}`}>{prompt}</label>{' '}
              <select
                id={`cbt-input-${item.placementId}`}
                className={s.select}
                data-active={active}
                value={current}
                disabled={disabled}
                onFocus={() => onSelect(item.placementId)}
                onChange={(e) => onAnswer(item.placementId, e.target.value)}
              >
                <option value="" />
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {t === 'HEADING_MATCHING' ? `${o.id}  ${cbtOptionText(o)}` : o.text && o.text !== o.id ? `${o.id}  ${cbtOptionText(o)}` : o.id}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </div>
      );
    }

    if (options.length > 0) {
      const truth = t === 'TRUTH_CLASSIFICATION' || isClosedTruthSet(options);
      return (
        <div key={item.placementId} {...common}>
          {stem}
          <ChoiceList item={item} options={options} value={value} onAnswer={onAnswer} onSelect={onSelect} disabled={disabled} showKeys={!truth} />
        </div>
      );
    }

    // No canonical options for a choice item: say so instead of inventing TRUE / FALSE / A–D.
    return (
      <div key={item.placementId} {...common}>
        {stem}
        <p className={s.unavailable}>The answer options for this question are not available.</p>
      </div>
    );
  };

  const handled = new Set<string>();
  if (template && template.complete) items.forEach((it) => handled.add(it.placementId));
  if (chooseN) selectionMembers.forEach((it) => handled.add(it.placementId));
  if (matrix) items.forEach((it) => handled.add(it.placementId));

  return (
    <section className={s.group} aria-label={heading || undefined} data-cbt-group={group.id}>
      {heading && <h3 className={s.groupHeading}>{heading}</h3>}
      {instructions.map((line, i) => (
        <p key={i} className={s.groupInstruction} data-capability="GROUP_INSTRUCTIONS">
          {emphasiseCapitals(line)}
        </p>
      ))}
      {wordRuleShown && (
        <p className={s.wordRule} data-capability="WORD_LIMIT_DISPLAY">
          {emphasiseCapitals(`Write ${String(p.wordLimitRule)} for each answer.`)}
        </p>
      )}
      {figures.map((f) => (
        <div key={f.asset.assetId} className={s.groupFigure}>
          <ExamAssetImage className={s.figureImg} attemptId={attemptId} asset={f.asset} alt={f.alt} />
        </div>
      ))}
      {headingList.length > 0 && (
        <>
          <p className={s.optionListTitle}>List of Headings</p>
          <ul className={s.optionList}>
            {headingList.map((o) => (
              <li key={o.id} className={s.optionListItem}>
                <span className={s.optionListKey}>{o.id}</span>
                {cbtOptionText(o)}
              </li>
            ))}
          </ul>
        </>
      )}
      {matrix && sharedOptions.some((o) => o.text && o.text !== o.id) && (
        <ul className={s.optionList}>
          {sharedOptions.map((o) => (
            <li key={o.id} className={s.optionListItem}>
              <span className={s.optionListKey}>{o.id}</span>
              {cbtOptionText(o)}
            </li>
          ))}
        </ul>
      )}
      {renderTemplate()}
      {renderChooseN()}
      {renderMatrix()}
      {items.map((it, i) => (handled.has(it.placementId) ? null : renderItem(it, i)))}
    </section>
  );
}
