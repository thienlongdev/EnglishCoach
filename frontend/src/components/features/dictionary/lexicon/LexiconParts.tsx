"use client";

/**
 * Echo Lexicon (owner brief 2026-10-24): the reading surfaces of the global dictionary — sense chapters, the Vietnamese
 * chapter, word relations and the related-phrases panel. Presentation only: every value is the dictionary's own, every
 * action is a handler of GlobalDictionarySearch.
 */
import React, { useMemo, useState } from "react";
import {
    ArrowRight,
    BookmarkCheck,
    BookmarkPlus,
    ChevronDown,
    ChevronUp,
    CornerDownRight,
    Loader2,
    Quote,
} from "lucide-react";
import type {
    CollocationsResponse,
    IdiomItem,
    PartOfSpeechGroup,
    PhrasalVerbItem,
    Sense,
    VietnameseSenseGroup,
} from "@/services/dictionary/types";
import {
    collocationGroupLabel,
    isLiteralNote,
    markHeadword,
    nestSenses,
    posLabelVi,
    sanitizeLexicalText,
} from "./lexiconText";
import styles from "./lexicon.module.css";

export const SENSES_SHOWN = 3;
const EXAMPLES_SHOWN = 2;

/** Text with the headword lit (examples, phrases). */
export function Marked({ text, headword }: { text: string; headword?: string }) {
    return (
        <>
            {markHeadword(text, headword).map((part, i) =>
                part.hit ? <b key={i} className={styles.hit}>{part.t}</b> : <React.Fragment key={i}>{part.t}</React.Fragment>
            )}
        </>
    );
}

/** A row of words that open their own entry; every word is reachable ("+n" opens the rest, nothing is cut). */
export function WordChips({ words, tone, onNavigate, initial = 8, label }: {
    words: string[];
    tone: "syn" | "ant" | "plain";
    onNavigate: (w: string) => void;
    initial?: number;
    label: string;
}) {
    const [all, setAll] = useState(false);
    const shown = all ? words : words.slice(0, initial);
    const rest = words.length - shown.length;
    return (
        <div className={styles.chipRow} data-tone={tone}>
            <span className={styles.chipLabel}>{label}</span>
            {shown.map((w) => (
                <button key={w} type="button" className={styles.wordChip} onClick={() => onNavigate(w)} title={`Tra “${w}”`}>
                    {w}
                </button>
            ))}
            {rest > 0 && (
                <button type="button" className={styles.moreChip} onClick={() => setAll(true)}>+{rest}</button>
            )}
        </div>
    );
}

export type SenseSaveState = { key: string; state: "saving" | "saved" | "error" } | null;

export function senseKeyOf(sense: Sense, posIdx: number, sIdx: number): string {
    return sense.id ? `${posIdx}:${sense.id}` : `${posIdx}_${sIdx}`;
}

type SenseRowProps = {
    sense: Sense;
    gloss: string;
    examples: string[];
    no: string;
    rowKey: string;
    sub?: boolean;
    index: number;
    headword: string;
    mode: "en-en" | "en-vi";
    expandedExamples: Record<string, boolean>;
    onToggleExamples: (key: string) => void;
    canSave: boolean;
    onSave: () => void;
    senseSave: SenseSaveState;
    onNavigate: (w: string) => void;
    children?: React.ReactNode;
};

function SenseRow({ sense, gloss, examples, no, rowKey, sub, index, headword, mode, expandedExamples, onToggleExamples, canSave, onSave, senseSave, onNavigate, children }: SenseRowProps) {
    const exOpen = !!expandedExamples[rowKey];
    const exShown = exOpen ? examples : examples.slice(0, EXAMPLES_SHOWN);
    const showVi = !!sense.translationVi && (mode === "en-vi" || !sense.definitionEn);
    const tags = [...(sense.labels || []), ...(sense.register ? [sense.register] : [])].filter(Boolean);
    const saving = senseSave?.key === rowKey ? senseSave.state : null;
    return (
        <li className={`${styles.sense} ${sub ? styles.subSense : ""}`} style={{ "--i": index } as React.CSSProperties}>
            <span className={styles.senseNo} aria-hidden="true">{no}</span>
            <div className={styles.senseBody}>
                {tags.length > 0 && (
                    <div className={styles.senseTags}>
                        {tags.slice(0, 6).map((t) => <span key={t}>{sanitizeLexicalText(t)}</span>)}
                    </div>
                )}
                {gloss && <p className={styles.senseDef}>{sanitizeLexicalText(gloss)}</p>}
                {showVi && (
                    <p className={styles.senseVi}>
                        <span className={styles.viTag}>VI</span>
                        {sanitizeLexicalText(sense.translationVi)}
                    </p>
                )}
                {examples.length > 0 && (
                    <div className={styles.examples}>
                        {exShown.map((ex, i) => (
                            <p key={i} className={styles.example}>
                                <Quote className={styles.exampleMark} aria-hidden="true" />
                                <span><Marked text={sanitizeLexicalText(ex)} headword={headword} /></span>
                            </p>
                        ))}
                        {examples.length > EXAMPLES_SHOWN && (
                            <button type="button" className={styles.textButton} onClick={() => onToggleExamples(rowKey)} aria-expanded={exOpen}>
                                {exOpen ? "Thu gọn ví dụ" : `Xem thêm ví dụ (+${examples.length - EXAMPLES_SHOWN})`}
                            </button>
                        )}
                    </div>
                )}
                {(sense.synonyms?.length ?? 0) > 0 && (
                    <WordChips words={sense.synonyms!} tone="syn" label="Đồng nghĩa" onNavigate={onNavigate} initial={6} />
                )}
                {(sense.antonyms?.length ?? 0) > 0 && (
                    <WordChips words={sense.antonyms!} tone="ant" label="Trái nghĩa" onNavigate={onNavigate} initial={6} />
                )}
                {children}
            </div>
            {canSave && (
                <button
                    type="button"
                    className={styles.senseSave}
                    data-state={saving || "idle"}
                    onClick={onSave}
                    disabled={saving === "saving" || saving === "saved"}
                    title={saving === "error" ? "Chưa lưu được — bấm để thử lại" : "Lưu nghĩa này vào Flashcard"}
                    aria-label={saving === "saved" ? "Đã lưu nghĩa này vào Flashcard" : "Lưu nghĩa này vào Flashcard"}
                >
                    {saving === "saving" ? <Loader2 className={styles.spin} /> : saving === "saved" ? <BookmarkCheck /> : <BookmarkPlus />}
                </button>
            )}
        </li>
    );
}

export function SenseChapter({
    group,
    posIdx,
    occurrence,
    headword,
    mode,
    expanded,
    onToggle,
    expandedExamples,
    onToggleExamples,
    canSave,
    onSaveSense,
    senseSave,
    onNavigate,
}: {
    group: PartOfSpeechGroup;
    posIdx: number;
    /** 2 for the second group of the same part of speech (a separate entry of the word, e.g. another etymology). */
    occurrence: number;
    headword: string;
    mode: "en-en" | "en-vi";
    expanded: boolean;
    onToggle: () => void;
    expandedExamples: Record<string, boolean>;
    onToggleExamples: (key: string) => void;
    canSave: boolean;
    onSaveSense: (sense: Sense, pos: string, key: string) => void;
    senseSave: SenseSaveState;
    onNavigate: (w: string) => void;
}) {
    const senses = group.senses || [];
    const items = useMemo(() => nestSenses(senses), [senses]);
    const visible = expanded ? items : items.slice(0, SENSES_SHOWN);
    const hiddenSenses = items.slice(SENSES_SHOWN).reduce((n, it) => n + 1 + it.children.length, 0);
    const vi = posLabelVi(group.partOfSpeech);
    const indexOf = (s: Sense) => senses.indexOf(s);
    const common = { headword, mode, expandedExamples, onToggleExamples, canSave, senseSave, onNavigate };
    return (
        <section className={styles.chapter} id={`lex-pos-${posIdx}`} aria-labelledby={`lex-pos-h-${posIdx}`}>
            <header className={styles.chapterHead}>
                <span className={styles.posBadge}>{group.partOfSpeech}</span>
                <h3 id={`lex-pos-h-${posIdx}`} className={styles.chapterTitle}>
                    {vi !== group.partOfSpeech ? vi : ""}
                    {occurrence > 1 && <span className={styles.chapterNth}> · mục {occurrence}</span>}
                </h3>
                <span className={styles.chapterCount}>{senses.length} nghĩa</span>
            </header>
            <ol className={styles.senseList}>
                {visible.map((item, n) => {
                    const key = senseKeyOf(item.sense, posIdx, indexOf(item.sense));
                    return (
                        <SenseRow
                            key={key}
                            {...common}
                            sense={item.sense}
                            gloss={item.gloss}
                            examples={item.examples}
                            no={String(n + 1)}
                            rowKey={key}
                            index={n}
                            onSave={() => onSaveSense({ ...item.sense, definitionEn: item.gloss || item.sense.definitionEn, examples: item.examples }, group.partOfSpeech, key)}
                        >
                            {item.children.length > 0 && (
                                <ol className={styles.subSenses}>
                                    {item.children.map((child, c) => {
                                        const ckey = senseKeyOf(child.sense, posIdx, indexOf(child.sense));
                                        return (
                                            <SenseRow
                                                key={ckey}
                                                {...common}
                                                sub
                                                sense={child.sense}
                                                gloss={child.gloss}
                                                examples={child.examples}
                                                no={String.fromCharCode(97 + (c % 26))}
                                                rowKey={ckey}
                                                index={n}
                                                onSave={() => onSaveSense(child.sense, group.partOfSpeech, ckey)}
                                            />
                                        );
                                    })}
                                </ol>
                            )}
                        </SenseRow>
                    );
                })}
            </ol>
            {hiddenSenses > 0 && (
                <button type="button" className={styles.moreSenses} onClick={onToggle} aria-expanded={expanded}>
                    {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                    {expanded ? "Thu gọn nghĩa" : `Xem thêm ${hiddenSenses} nghĩa khác`}
                </button>
            )}
        </section>
    );
}

/** The word's Vietnamese senses from the bundled EN–VI dictionary, by part of speech (not paired with the English senses). */
export function VietnameseChapter({ groups, source }: { groups: VietnameseSenseGroup[]; source?: string }) {
    const [open, setOpen] = useState<Record<number, boolean>>({});
    return (
        <section className={`${styles.chapter} ${styles.viChapter}`} aria-labelledby="lex-vi-h" data-testid="dictionary-vi-senses">
            <header className={styles.chapterHead}>
                <span className={`${styles.posBadge} ${styles.viBadge}`}>VI</span>
                <h3 id="lex-vi-h" className={styles.chapterTitle}>Các nghĩa tiếng Việt</h3>
            </header>
            <div className={styles.viGroups}>
                {groups.map((g, gi) => {
                    const all = !!open[gi];
                    const list = all ? g.meanings : g.meanings.slice(0, 6);
                    return (
                        <div key={gi} className={styles.viGroup}>
                            <span className={styles.viPos}>{posLabelVi(g.partOfSpeech)}</span>
                            <ol className={styles.viList}>
                                {list.map((m, i) => <li key={i}>{sanitizeLexicalText(m)}</li>)}
                            </ol>
                            {g.meanings.length > 6 && (
                                <button type="button" className={styles.textButton} onClick={() => setOpen((p) => ({ ...p, [gi]: !all }))} aria-expanded={all}>
                                    {all ? "Thu gọn" : `Xem thêm ${g.meanings.length - 6} nghĩa`}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
            {source && <p className={styles.sourceNote}>Nguồn: {source}</p>}
            <p className={styles.sourceNote}>Đây là các nghĩa của cả từ, không phải bản dịch từng nghĩa tiếng Anh bên dưới.</p>
        </section>
    );
}

/** Synonyms / antonyms that belong to the word, not to one sense: told as such. */
export function RelationsCard({ synonyms, antonyms, onNavigate }: {
    synonyms: string[];
    antonyms: string[];
    onNavigate: (w: string) => void;
}) {
    return (
        <section className={`${styles.chapter} ${styles.relations}`} aria-labelledby="lex-rel-h" data-testid="dictionary-word-relations">
            <header className={styles.chapterHead}>
                <h3 id="lex-rel-h" className={styles.chapterTitle}>Từ liên quan</h3>
            </header>
            {synonyms.length > 0 && <WordChips words={synonyms} tone="syn" label="Đồng nghĩa" onNavigate={onNavigate} />}
            {antonyms.length > 0 && <WordChips words={antonyms} tone="ant" label="Trái nghĩa" onNavigate={onNavigate} />}
            <p className={styles.sourceNote}>Các từ này chỉ thay được cho từ gốc ở một số nghĩa — xem nghĩa của chúng trước khi dùng.</p>
        </section>
    );
}

export type UsageTab = "collocations" | "phrasal_verbs" | "idioms" | "expressions";

export function UsagePanel({
    tab,
    headword,
    loading,
    collocations,
    phrasalVerbs,
    idioms,
    expressions,
    onNavigate,
}: {
    tab: UsageTab;
    headword: string;
    loading: boolean;
    collocations: CollocationsResponse | null;
    phrasalVerbs: PhrasalVerbItem[];
    idioms: IdiomItem[];
    expressions: IdiomItem[];
    onNavigate: (w: string) => void;
}) {
    const [openRow, setOpenRow] = useState<string | null>(null);

    if (loading && tab === "collocations" && !collocations) return <UsageSkeleton />;

    if (tab === "collocations") {
        const groups = (collocations?.groups || []).filter((g) => g.items?.length);
        if (!groups.length) return loading ? <UsageSkeleton /> : null;
        return (
            <div className={styles.collGrid}>
                {groups.map((group) => {
                    const label = collocationGroupLabel(group.pattern, headword);
                    return (
                        <section key={group.pattern} className={styles.collGroup} aria-label={label.title}>
                            <header className={styles.collHead}>
                                {label.formula.length > 0 && (
                                    <span className={styles.formula} aria-hidden="true">
                                        {label.formula.map((f, i) => (
                                            <React.Fragment key={i}>
                                                {i > 0 && <span className={styles.formulaPlus}>+</span>}
                                                <span className={f === headword ? styles.formulaHead : styles.formulaSlot}>{f}</span>
                                            </React.Fragment>
                                        ))}
                                    </span>
                                )}
                                <h3 className={styles.collTitle}>{label.title}</h3>
                                <span className={styles.chapterCount}>{group.items.length} cụm</span>
                            </header>
                            <ul className={styles.collRows}>
                                {group.items.map((item) => {
                                    const hasDetails = !!(item.translationVi || item.example);
                                    const open = openRow === item.phrase;
                                    return (
                                        <li key={item.phrase} className={styles.collRow} data-open={open || undefined}>
                                            <div className={styles.collLine}>
                                                {hasDetails ? (
                                                    <button type="button" className={styles.collPhraseBtn} onClick={() => setOpenRow(open ? null : item.phrase)} aria-expanded={open}>
                                                        <Marked text={item.phrase} headword={headword} />
                                                        {open ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                                                    </button>
                                                ) : (
                                                    <span className={styles.collPhrase}><Marked text={item.phrase} headword={headword} /></span>
                                                )}
                                                {item.translationVi && !open && <span className={styles.collVi}>{sanitizeLexicalText(item.translationVi)}</span>}
                                                {item.hasExactEntry && (
                                                    <button type="button" className={styles.goEntry} onClick={() => onNavigate(item.phrase)} aria-label={`Xem mục từ “${item.phrase}”`} title="Xem mục từ">
                                                        <ArrowRight aria-hidden="true" />
                                                    </button>
                                                )}
                                            </div>
                                            {open && (
                                                <div className={styles.collDetail}>
                                                    {item.translationVi && <p className={styles.senseVi}><span className={styles.viTag}>VI</span>{sanitizeLexicalText(item.translationVi)}</p>}
                                                    {item.example && (
                                                        <p className={styles.example}>
                                                            <Quote className={styles.exampleMark} aria-hidden="true" />
                                                            <span><Marked text={sanitizeLexicalText(item.example)} headword={headword} /></span>
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    );
                })}
                <p className={styles.sourceNote}>
                    Các cụm được lấy từ kho văn bản thật (Datamuse) và danh sách chọn lọc; “Từ thường đi liền sau” chỉ cho biết vị trí, không phải loại từ.
                </p>
            </div>
        );
    }

    if (tab === "phrasal_verbs") {
        return (
            <div className={styles.phraseGrid}>
                {phrasalVerbs.map((pv) => {
                    const meaning = sanitizeLexicalText(pv.shortMeaning);
                    const literal = isLiteralNote(meaning);
                    return (
                        <button key={pv.phrase} type="button" className={styles.phraseCard} onClick={() => onNavigate(pv.phrase)}>
                            <span className={styles.phraseName}><Marked text={pv.phrase} headword={headword} /></span>
                            {meaning && (
                                <span className={literal ? styles.phraseLiteral : styles.phraseMeaning}>
                                    {literal ? "Nghĩa đen — theo nghĩa của từng từ." : meaning}
                                </span>
                            )}
                            <CornerDownRight className={styles.phraseGo} aria-hidden="true" />
                        </button>
                    );
                })}
            </div>
        );
    }

    const list = tab === "idioms" ? idioms : expressions;
    return (
        <div className={styles.phraseGrid}>
            {list.map((item) => {
                const meaning = sanitizeLexicalText(item.shortMeaning);
                const literal = isLiteralNote(meaning);
                return (
                    <button key={item.phrase} type="button" className={`${styles.phraseCard} ${styles.idiomCard}`} onClick={() => onNavigate(item.phrase)}>
                        <span className={styles.phraseName}><Marked text={item.phrase} headword={headword} /></span>
                        {meaning && (
                            <span className={literal ? styles.phraseLiteral : styles.phraseMeaning}>
                                {literal ? "Nghĩa đen — theo nghĩa của từng từ." : meaning}
                            </span>
                        )}
                        {item.translationVi && (
                            <span className={styles.senseVi}><span className={styles.viTag}>VI</span>{sanitizeLexicalText(item.translationVi)}</span>
                        )}
                        {item.examples && item.examples.length > 0 && (
                            <span className={styles.phraseExample}>“{sanitizeLexicalText(item.examples[0])}”</span>
                        )}
                        <CornerDownRight className={styles.phraseGo} aria-hidden="true" />
                    </button>
                );
            })}
        </div>
    );
}

function UsageSkeleton() {
    return (
        <div className={styles.collGrid} aria-hidden="true">
            {[0, 1].map((k) => (
                <div key={k} className={`${styles.collGroup} ${styles.skeletonCard}`}>
                    <i style={{ width: "40%" }} /><i /><i /><i style={{ width: "70%" }} /><i style={{ width: "55%" }} />
                </div>
            ))}
        </div>
    );
}

/** The result layout drawn while the first word of a session is on its way (no decorative wait). */
export function ResultSkeleton() {
    return (
        <div className={styles.result} aria-hidden="true">
            <div className={`${styles.identity} ${styles.skeletonIdentity}`}>
                <i style={{ width: "30%" }} /><i className={styles.skHead} /><i style={{ width: "50%" }} /><i className={styles.skButton} />
            </div>
            <div className={styles.explore}>
                <div className={styles.exploreScroll}>
                    {[0, 1].map((k) => (
                        <div key={k} className={`${styles.chapter} ${styles.skeletonCard}`}>
                            <i style={{ width: "22%" }} /><i /><i style={{ width: "85%" }} /><i /><i style={{ width: "60%" }} />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
