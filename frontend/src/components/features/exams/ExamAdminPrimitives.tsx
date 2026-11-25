'use client';

import React from 'react';

export const panelClass = 'rounded-xl border border-border bg-card p-5 shadow-sm';
export const inputClass = 'mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary';
export const buttonClass = 'inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
export const secondaryButtonClass = 'inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

export function SectionTitle({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-sm font-bold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-foreground">
      {label}
      {hint && <span className="ml-1 font-normal text-muted-foreground">({hint})</span>}
      {children}
    </label>
  );
}

export function KeyValueList({ values }: { values: Array<[string, string | number | undefined]> }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {values.map(([key, value]) => (
        <div key={key} className="rounded-md border border-border/70 px-3 py-2">
          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{key}</dt>
          <dd className="mt-1 break-words font-mono text-xs text-foreground">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-[11px] leading-5 text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

