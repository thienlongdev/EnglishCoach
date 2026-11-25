'use client';

import React, { useMemo } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { parseInline, parseRoleTree, type InlineNode, type RoleNode } from '@/lib/grammar/inline';
import { ROLE_INFO, ROLE_ORDER, cx, roleTag } from '@/lib/grammar/format';
import styles from './grammar.module.css';

/**
 * The two inline mark-ups of the Grammar content, rendered.
 *  - `<En text="[S|She] [V|lives] here." />`: English with role mark-up. A role is drawn (colour + underline style + a tag on
 *    hover) only inside a `.showRoles` ancestor or when `roles` is set; otherwise the words are plain.
 *  - `<Vi text="Dùng **đã** và `yesterday`." />`: Vietnamese with `**bold**` and `` `form` ``.
 *  - `<Rich text />`: text that may hold both (table cells, notes, flow answers).
 */

function renderInline(nodes: InlineNode[], keyPrefix = ''): React.ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    if (n.k === 'text') return <React.Fragment key={key}>{n.t}</React.Fragment>;
    if (n.k === 'b') return <strong key={key} className={styles.bold}>{renderInline(n.children, `${key}.`)}</strong>;
    return <span key={key} className={styles.form} lang="en">{n.t}</span>;
  });
}

function renderRoles(nodes: RoleNode[], vi: boolean, withInline: boolean, keyPrefix = ''): React.ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    if ('t' in n) return <React.Fragment key={key}>{withInline ? renderInline(parseInline(n.t), `${key}:`) : n.t}</React.Fragment>;
    return (
      <span key={key} className={styles.role} data-role={n.role} data-tag={roleTag(n.role, vi)}>
        {renderRoles(n.children, vi, withInline, `${key}.`)}
      </span>
    );
  });
}

type Tag = 'span' | 'p' | 'div' | 'q' | 'strong' | 'li';

interface TextProps { text: string; className?: string; as?: Tag }

export function En({ text, roles, className, as = 'span' }: TextProps & { roles?: boolean }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const tree = useMemo(() => parseRoleTree(text), [text]);
  const Tag = as as React.ElementType;
  return (
    <Tag lang="en" className={cx(styles.en, roles && styles.showRoles, className)}>
      {renderRoles(tree, vi, false)}
    </Tag>
  );
}

export function Vi({ text, className, as = 'span' }: TextProps) {
  const nodes = useMemo(() => parseInline(text), [text]);
  const Tag = as as React.ElementType;
  return <Tag className={cx(styles.vi, className)}>{renderInline(nodes)}</Tag>;
}

/** Text that may carry role mark-up and Vietnamese marks (language not assumed). */
export function Rich({ text, className, as = 'span' }: TextProps) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const tree = useMemo(() => parseRoleTree(text), [text]);
  const Tag = as as React.ElementType;
  return <Tag className={cx(styles.rich, className)}>{renderRoles(tree, vi, true)}</Tag>;
}

/**
 * Key to the role marks. `only` limits it to the roles the page actually uses. The samples sit inside `.showRoles`, so they
 * are drawn exactly as in the examples.
 */
export function RoleLegend({ only, className }: { only?: Iterable<string>; className?: string }) {
  const { locale } = useLanguage();
  const vi = locale === 'vi';
  const wanted = only ? new Set(only) : null;
  const roles = ROLE_ORDER.filter((r) => !wanted || wanted.has(r));
  if (!roles.length) return null;
  return (
    <div className={cx(styles.legend, styles.showRoles, className)} role="group" aria-label={vi ? 'Chú giải: vai trò của từ trong câu' : 'Key: the role of each word in the sentence'}>
      <ul className={styles.legendList}>
        {roles.map((r) => (
          <li key={r} className={styles.legendItem}>
            <span className={styles.role} data-role={r} lang="en">{r}</span>
            <span className={styles.legendName}>{vi ? ROLE_INFO[r].vi : ROLE_INFO[r].en}</span>
          </li>
        ))}
      </ul>
      <p className={styles.legendNote}>
        {vi
          ? 'Mỗi vai trò có một màu và một kiểu gạch riêng; rê chuột vào từ để xem tên vai trò.'
          : 'Each role has its own colour and underline style; hover a word to see its role.'}
      </p>
    </div>
  );
}
