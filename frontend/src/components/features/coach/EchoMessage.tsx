'use client';
import React from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { messageActions } from './echo-window';
import { EchoCards, type EchoActionData, type EchoCardData } from './EchoCards';

/**
 * Deliberately strict text renderer. React escapes HTML; model output never creates hrefs/DOM. The only formatting read
 * from the text is **bold** (a <strong> element) and leading "- " bullets / "### " heading markers (shown as plain text).
 * Structured cards and navigation come from server tools (EchoCards), never from the model's words.
 */
export function formatEchoText(text: string): React.ReactNode[] {
  return text.split('\n').flatMap((line, i, all) => {
    const heading = /^#{1,4}\s+/.test(line);
    const clean = line.replace(/^#{1,4}\s+/, '');
    const parts = clean.split(/(\*\*[^*\n]{1,120}\*\*)/g).map((part, j) =>
      /^\*\*[^*\n]{1,120}\*\*$/.test(part) ? React.createElement('strong', { key: j }, part.slice(2, -2)) : part);
    const node = heading ? React.createElement('strong', { key: `l${i}` }, ...parts) : React.createElement(React.Fragment, { key: `l${i}` }, ...parts);
    return i < all.length - 1 ? [node, '\n'] : [node];
  });
}

export const EchoMessage = React.memo(function EchoMessage({ role, content, cards = [], actions = [] }: { role: 'user' | 'assistant'; content: string; cards?: EchoCardData[]; actions?: EchoActionData[] }) {
  const router = useRouter();
  const { locale } = useLanguage();
  const legacy = role === 'assistant' ? messageActions(content) : [];
  const text = legacy.reduce((value, action) => value.replaceAll(action.tag, ''), content);
  return <div className={`echo-message echo-message-${role}`}>
    <div className="echo-text">{role === 'assistant' ? formatEchoText(text) : text}</div>
    {role === 'assistant' && (cards.length > 0 || actions.length > 0) && <EchoCards cards={cards} actions={actions} vi={locale === 'vi'} />}
    {legacy.length > 0 && <div className="echo-actions">{legacy.map(action =>
      <button type="button" key={action.tag} onClick={() => router.push(action.route)}>{locale === 'vi' ? action.vi : action.en} →</button>)}</div>}
  </div>;
});
