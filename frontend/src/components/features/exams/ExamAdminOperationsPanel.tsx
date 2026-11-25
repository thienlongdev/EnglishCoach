'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Image as ImageIcon, Loader2, RefreshCw, Search, XCircle } from 'lucide-react';
import { examAdminApi, getApiErrorMessage } from '@/services/examAdminApi';
import type {
  OpsImportPlan,
  OpsOverview,
  OpsPackageDetail,
  OpsPackageRow,
  OpsPersistedForm,
  OpsQaEntry,
  OpsRights,
} from '@/types/exam-admin';
import type { AdminMessage } from './ExamAdminConsole';
import { KeyValueList, SectionTitle, buttonClass, inputClass, panelClass, secondaryButtonClass } from './ExamAdminPrimitives';

const GATE_KEYS: Array<[string, string]> = [
  ['STRUCTURAL_VALID', 'Struct'], ['RUNNER_COMPATIBLE', 'Runner'], ['SCORING_COMPATIBLE', 'Scoring'], ['MEDIA_READY', 'Media'],
  ['QA_APPROVED', 'QA'], ['PROJECT_AUTHORIZED', 'Auth'], ['PROVENANCE_COMPLETE', 'Prov'],
];

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold ${ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}
      title={`${label}: ${ok ? 'yes' : 'no'}`}>
      {ok ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <XCircle className="h-3 w-3" aria-hidden />}{label}
    </span>
  );
}

function Codes({ codes, empty = '—' }: { codes?: string[]; empty?: string }) {
  if (!codes || codes.length === 0) return <span className="text-xs text-muted-foreground">{empty}</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {codes.map((c) => <li key={c} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">{c}</li>)}
    </ul>
  );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="rounded-lg border border-border">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-bold text-foreground">{title}</summary>
      <div className="min-w-0 space-y-3 overflow-x-auto border-t border-border p-3">{children}</div>
    </details>
  );
}

function RightsView({ rights }: { rights: OpsRights }) {
  const auth = rights.projectAuthorization || {};
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="min-w-0 rounded-md border border-border p-3 space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Project authorization</p>
        <p className="font-mono text-xs">{String(auth.status ?? '—')}</p>
        <p className="text-[11px] text-muted-foreground">permits: {Array.isArray(auth.permits) ? (auth.permits as string[]).join(', ') : '—'}</p>
        <p className="text-[11px] text-muted-foreground">production import: {String(auth.productionImport ?? '—')} · endorsement: {String(auth.publisherEndorsement ?? '—')}</p>
      </div>
      <div className="min-w-0 rounded-md border border-border p-3 space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Publisher licence</p>
        {(rights.publisherLicences || []).length === 0 && <p className="text-xs text-muted-foreground">No licence row</p>}
        {(rights.publisherLicences || []).map((l, i) => (
          <p key={i} className="font-mono text-[11px]">{String(l.licenseCode ?? '—')} · {String(l.legalStatus ?? '—')} · {String(l.provenanceCategory ?? '—')}</p>
        ))}
        <Codes codes={rights.publisherLicenceGapCodes} empty="no closure gap" />
      </div>
      <div className="min-w-0 overflow-x-auto rounded-md border border-border p-3 space-y-1 lg:col-span-2">
        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Operation basis → decision ({rights.policyVersion})</p>
        <table className="w-full text-[11px]">
          <tbody>
            {rights.decisions.map((d) => (
              <tr key={`${d.basis}/${d.operation}`} className="align-top">
                <td className="pr-2 font-mono">{d.basis}</td>
                <td className="pr-2 font-mono">{d.operation}</td>
                <td className={`pr-2 font-bold ${d.allowed ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>{d.allowed ? 'ALLOW' : 'DENY'}</td>
                <td className="font-mono text-muted-foreground">{d.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanView({ plan }: { plan: OpsImportPlan }) {
  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <p className="text-xs font-bold">{plan.target} · <span className="font-mono">{plan.operation}</span> <span className="text-muted-foreground">(content: {plan.contentOperation})</span></p>
      <p className="text-[11px] text-muted-foreground font-mono break-all">{plan.planVersion} · {plan.planId}</p>
      <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Blockers</p><Codes codes={plan.blockers} empty="none" /></div>
      {plan.notes.length > 0 && <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Notes</p><Codes codes={plan.notes} /></div>}
      <p className="text-[11px] text-muted-foreground">planned form v{plan.plannedFormVersion} · package v{plan.plannedPackageVersion} · changed {plan.changedPlacements} / reused {plan.reusedPlacements}</p>
    </div>
  );
}

function QaDecisionForm({ testId, entry, onDone }: { testId: string; entry: OpsQaEntry; onDone: (m: AdminMessage) => void }) {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | 'CORRECT'>('APPROVE');
  const [corrected, setCorrected] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!entry.fingerprint || busy) return;
    setBusy(true);
    try {
      const r = await examAdminApi.recordQaDecision({
        testId, entryId: entry.entryId, decision, fingerprint: entry.fingerprint,
        correctedValue: decision === 'CORRECT' ? corrected : undefined, note: note || undefined,
      });
      onDone({ type: 'success', text: `${r.decision} recorded for ${r.entryId} by ${r.reviewer} at ${r.reviewedAt} (was ${r.previousStatus}). Effective after the next qa-review run.` });
    } catch (e) {
      onDone({ type: 'error', text: getApiErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-[11px] font-semibold">Decision
        <select className={inputClass} value={decision} onChange={(e) => setDecision(e.target.value as 'APPROVE' | 'REJECT' | 'CORRECT')}>
          <option value="APPROVE">APPROVE</option><option value="REJECT">REJECT</option><option value="CORRECT">CORRECT</option>
        </select>
      </label>
      {decision === 'CORRECT' && (
        <label className="text-[11px] font-semibold">Corrected value<input className={inputClass} value={corrected} onChange={(e) => setCorrected(e.target.value)} /></label>
      )}
      <label className="text-[11px] font-semibold flex-1 min-w-[160px]">Note<input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      <button type="button" className={buttonClass} disabled={busy || (decision === 'CORRECT' && !corrected.trim())} onClick={submit}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'Record decision'}
      </button>
    </div>
  );
}

function QaTable({ testId, entries, onDone }: { testId: string; entries: OpsQaEntry[]; onDone: (m: AdminMessage) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">None.</p>;
  return (
    <table className="w-full text-[11px]">
      <thead className="text-left text-muted-foreground"><tr><th className="py-1">Entry</th><th>Priority</th><th>Type / subtype</th><th>Status</th><th>Questions / page</th><th>Ledger</th><th /></tr></thead>
      <tbody>
        {entries.map((e) => (
          <React.Fragment key={e.entryId}>
            <tr className="border-t border-border align-top">
              <td className="py-1 pr-2 font-mono">{e.entryId}<br /><span className="text-muted-foreground break-all">{e.fingerprint}</span></td>
              <td className="pr-2 font-mono">{e.releasePriority || '—'}</td>
              <td className="pr-2 font-mono">{e.type || e.kind} {e.subtype ? `/ ${e.subtype}` : ''}{e.technical ? ` / ${e.technical}` : ''}</td>
              <td className="pr-2 font-mono">{e.status}{!e.reportCurrent && <span className="block text-rose-700 dark:text-rose-300">report stale</span>}</td>
              <td className="pr-2 font-mono">{e.questions ? JSON.stringify(e.questions) : '—'}{typeof e.page === 'number' ? ` · p${e.page}` : ''}</td>
              <td className="pr-2">{e.latestDecision ? `${e.latestDecision.decision} · ${e.latestDecision.reviewer}${e.latestDecision.fingerprintCurrent ? '' : ' (stale fingerprint)'}${e.decisionPendingApplication ? ' · pending qa-review' : ''}` : '—'}</td>
              <td>{e.decidable && <button type="button" className={secondaryButtonClass} onClick={() => setOpen(open === e.entryId ? null : e.entryId)}
                aria-expanded={open === e.entryId} aria-label={`Decide ${e.entryId}`}>Decide</button>}</td>
            </tr>
            {open === e.entryId && (
              <tr><td colSpan={7} className="pb-3"><QaDecisionForm testId={testId} entry={e} onDone={(m) => { setOpen(null); onDone(m); }} /></td></tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

function MediaPreview({ testId, sha256 }: { testId: string; sha256: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (url) return <img src={url} alt={`staged image ${sha256.slice(0, 12)}`} className="max-h-48 rounded border border-border object-contain" />;
  return (
    <button type="button" className={secondaryButtonClass} aria-label={`Preview image ${sha256.slice(0, 12)}`} onClick={async () => {
      try { setUrl(URL.createObjectURL(await examAdminApi.getOperationsMediaBlob(testId, sha256))); } catch { setFailed(true); }
    }}>
      <ImageIcon className="mr-1 h-3.5 w-3.5" aria-hidden />{failed ? 'Unavailable' : 'Preview'}
    </button>
  );
}

function PackageDetail({ testId, onMessage }: { testId: string; onMessage: (m: AdminMessage) => void }) {
  const [detail, setDetail] = useState<OpsPackageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setDetail(await examAdminApi.getOperationsPackage(testId)); } catch (e) { setError(getApiErrorMessage(e)); }
  }, [testId]);
  useEffect(() => { load(); }, [load]);
  if (error) return <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p>;
  if (!detail) return <p className="text-xs text-muted-foreground">Loading {testId}…</p>;
  const s = detail.summary;
  const done = (m: AdminMessage) => { onMessage(m); load(); };
  return (
    <div className="space-y-3">
      <KeyValueList values={[
        ['Test', s.testId], ['Source key', s.sourceKey], ['Package', `${s.packageId} v${s.packageVersion}`], ['Phase 2', `${s.phase2Status} (${detail.validatorVersion})`],
        ['Semantic fingerprint', s.semanticFingerprint], ['Manifest hash', s.manifestContentHash],
        ['Disposition', `${s.disposition}${s.dispositionReportStale ? ' (matrix report stale)' : ''}`], ['Next action', detail.nextAction],
      ]} />
      <Section title="Release gate" defaultOpen>
        <div className="flex flex-wrap gap-2">
          {GATE_KEYS.map(([k, l]) => <Flag key={k} ok={!!s.gate[k]} label={l} />)}
          <Flag ok={s.importReady} label="IMPORT_READY" />
          <span className="text-[11px] text-muted-foreground">READY_EXCEPT_HUMAN_QA: {String(s.readyExceptHumanQa)} (informational, never an import permission)</span>
        </div>
        <Codes codes={detail.gateReasons} empty="no gate reason" />
        <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Disposition reason codes</p><Codes codes={detail.dispositionReasonCodes} /></div>
      </Section>
      <Section title="Validation and runtime compatibility">
        <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Phase 2 blocking</p><Codes codes={detail.phase2BlockingCodes} empty="none" /></div>
        <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Runner blocking</p><Codes codes={detail.runnerBlocking} empty="none" /></div>
        <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Scoring blocking</p><Codes codes={detail.scoringBlocking} empty="none" /></div>
        <div><p className="text-[10px] font-bold uppercase text-muted-foreground">Review codes</p><Codes codes={detail.reviewCodes} empty="none" /></div>
      </Section>
      <Section title={`Human QA blockers (${detail.qaEntries.length})`} defaultOpen>
        <p className="text-[11px] text-muted-foreground">Decisions are appended to the fingerprinted ledger (qa/approvals.json) with your account and the server time, and take effect when qa-review is re-run. A stale fingerprint or report is refused; nothing is approved automatically.</p>
        <QaTable testId={testId} entries={detail.qaEntries} onDone={done} />
      </Section>
      <Section title={`Crop review units (${detail.cropUnits.length})`}>
        <p className="text-[11px] text-muted-foreground">TECHNICALLY_VALID is a technical check, not an approval.</p>
        <QaTable testId={testId} entries={detail.cropUnits} onDone={done} />
      </Section>
      <Section title={`Media (${detail.media.length})`}>
        <table className="w-full text-[11px]">
          <thead className="text-left text-muted-foreground"><tr><th className="py-1">SHA-256</th><th>MIME / role</th><th>Validation</th><th>File</th><th>Bindings</th><th>Crop</th><th>Ready</th><th /></tr></thead>
          <tbody>
            {detail.media.map((m) => (
              <tr key={m.assetId} className="border-t border-border align-top">
                <td className="py-1 pr-2 font-mono break-all">{m.sha256.slice(0, 16)}…</td>
                <td className="pr-2 font-mono">{m.mimeType} / {m.roles.join(',')}</td>
                <td className="pr-2 font-mono">{m.validationState}</td>
                <td className="pr-2 font-mono">{m.sourceKind} / {m.fileStatus}</td>
                <td className="pr-2">{m.bindingCount}</td>
                <td className="pr-2 font-mono">{m.cropTechnical || '—'}{m.cropHumanApproved ? ' / human ✓' : m.waitingOnlyForHuman ? ' / awaiting human' : ''}</td>
                <td className="pr-2">{m.ready ? 'yes' : 'no'}</td>
                <td>{m.previewable && <MediaPreview testId={testId} sha256={m.sha256} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title={`Practice scopes (${detail.practiceScopes.length})`}>
        <p className="text-[11px] text-muted-foreground">{detail.practiceBasisNote}</p>
        <table className="w-full text-[11px]"><tbody>
          {detail.practiceScopes.map((p) => (
            <tr key={p.scopeCode} className="border-t border-border align-top">
              <td className="py-1 pr-2 font-mono">{p.scopeCode}</td><td className="pr-2 font-mono">{p.learnerState}</td>
              <td className="pr-2">{p.questionCount} items</td><td><Codes codes={p.reasonCodes} empty="ready" /></td>
            </tr>
          ))}
        </tbody></table>
      </Section>
      <Section title="Rights and provenance" defaultOpen>
        <RightsView rights={detail.rights} />
        <div className="rounded-md border border-border p-3 space-y-1">
          <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Provenance</p>
          <p className="text-xs">{detail.provenance.complete ? 'Complete' : 'Incomplete'} · {detail.provenance.extractorName} {detail.provenance.extractorVersion} · review {detail.provenance.reviewStatus}</p>
          <p className="font-mono text-[11px] break-all text-muted-foreground">{detail.provenance.rawSourcePath} · {detail.provenance.rawSourceSha256}</p>
          <Codes codes={detail.provenance.gaps} empty="no provenance gap" />
        </div>
      </Section>
      <Section title="Import plan (planner output; the release gate decides — no manual import control)" defaultOpen>
        <div className="grid gap-3 lg:grid-cols-2">{detail.importPlans.map((p) => <PlanView key={p.target} plan={p} />)}</div>
      </Section>
      <Section title="Lifecycle plan and legacy mapping">
        <p className="text-xs">Mode: <span className="font-mono">{detail.lifecycle.executionMode}</span> · publication allowed: {String(detail.lifecycle.publicationAllowed)}</p>
        <Codes codes={detail.lifecycle.publicationBlockers} />
        <Codes codes={detail.lifecycle.retirementNotes} empty="no retirement consideration" />
        <table className="w-full text-[11px]"><tbody>
          {detail.legacyMappings.map((m, i) => (
            <tr key={i} className="border-t border-border"><td className="py-1 pr-2 font-mono">{m.legacyLogicalKey}</td><td className="pr-2 font-mono">{m.status}</td><td className="pr-2 font-mono">{m.proposedAction}</td><td>executed: {String(m.executed)}</td></tr>
          ))}
        </tbody></table>
      </Section>
    </div>
  );
}

function PersistedFormLookup({ onMessage }: { onMessage: (m: AdminMessage) => void }) {
  const [formId, setFormId] = useState('');
  const [form, setForm] = useState<OpsPersistedForm | null>(null);
  async function load() {
    try { setForm(await examAdminApi.getOperationsForm(formId.trim())); } catch (e) { setForm(null); onMessage({ type: 'error', text: getApiErrorMessage(e) }); }
  }
  return (
    <div className={panelClass}>
      <SectionTitle title="Persisted form (database)" description="Validation, practice readiness, rights (production publisher-licence basis) and the publication plan of one imported form." />
      <div className="mt-3 flex gap-2">
        <input className={inputClass} placeholder="form id (UUID)" value={formId} onChange={(e) => setFormId(e.target.value)} />
        <button type="button" className={buttonClass} disabled={!/^[0-9a-f-]{36}$/i.test(formId.trim())} onClick={load}>Inspect</button>
      </div>
      {form && (
        <div className="mt-3 space-y-3">
          <KeyValueList values={[
            ['Form', `${form.logicalKey} v${form.version}`], ['Lifecycle', form.lifecycleState], ['Validation', String(form.validation.status)],
            ['Full simulation', String(form.validation.fullSimulationEligible)], ['Recorded identity', form.recordedPackageIdentity ? String(form.recordedPackageIdentity.sourceKey) : 'none'],
          ]} />
          <RightsView rights={form.rights} />
          <Codes codes={form.lifecycle.publicationBlockers} />
        </div>
      )}
    </div>
  );
}

/**
 * Exams Phase 8D — operations center: canonical release / QA / media / rights / import-plan truth of the staged corpus
 * (local Exams worktree) and of persisted forms. Read-only except fingerprinted human QA decisions. No import, publish,
 * retire or gate-bypassing control exists here.
 */
export const ExamAdminOperationsPanel: React.FC<{ onMessage: (m: AdminMessage) => void }> = ({ onMessage }) => {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [disposition, setDisposition] = useState('ALL');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setOverview(await examAdminApi.getOperationsOverview()); } catch (e) { setError(getApiErrorMessage(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => (overview?.packages || []).filter((r: OpsPackageRow) =>
    (disposition === 'ALL' || r.disposition === disposition || (disposition === 'READY_EXCEPT_HUMAN_QA' && r.readyExceptHumanQa))
    && (!query || `${r.testId} ${r.sourceKey} ${r.packageId}`.toLowerCase().includes(query.toLowerCase()))), [overview, query, disposition]);

  return (
    <div className="space-y-5">
      <div className={panelClass}>
        <SectionTitle title="Exams operations center"
          description="Derived from the canonical validator, runtime audit, media plan, release gate, rights policy, practice readiness, import planner and the fingerprinted QA ledger. Nothing here is a stored flag."
          action={<button type="button" className={secondaryButtonClass} onClick={load} disabled={loading}><RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />Refresh</button>} />
        {error && <p className="mt-3 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
        {overview && !overview.stagingConfigured && <p className="mt-3 text-xs text-muted-foreground">{overview.stagingNote}</p>}
        {overview?.stagingConfigured && (
          <div className="mt-4 grid gap-3 lg:grid-cols-4">
            <div className="rounded-md border border-border p-3"><p className="text-[10px] font-bold uppercase text-muted-foreground">Release gate (of {overview.gateTotals.PACKAGES})</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">{Object.entries(overview.gateTotals).filter(([k]) => k !== 'PACKAGES').map(([k, v]) => <li key={k}>{k} {v}</li>)}</ul></div>
            <div className="rounded-md border border-border p-3"><p className="text-[10px] font-bold uppercase text-muted-foreground">Dispositions</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">{Object.entries(overview.dispositionTotals).map(([k, v]) => <li key={k}>{k} {v}</li>)}</ul></div>
            <div className="rounded-md border border-border p-3"><p className="text-[10px] font-bold uppercase text-muted-foreground">Practice scopes (staging basis)</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">{Object.entries(overview.practiceScopeTotals).map(([k, v]) => <li key={k}>{k} {v}</li>)}</ul></div>
            <div className="rounded-md border border-border p-3"><p className="text-[10px] font-bold uppercase text-muted-foreground">QA decision ledger</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                <li>present {String(overview.ledger.present)}</li><li>valid {overview.ledger.validDecisions}</li><li>invalid {overview.ledger.invalidRecords}</li>
                <li>via admin center {overview.ledger.recordedViaAdminCenter}</li><li>pending qa-review {overview.ledger.pendingApplication}</li>
              </ul></div>
          </div>
        )}
      </div>

      {overview?.stagingConfigured && (
        <div className={panelClass}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[200px] text-xs font-semibold">Search
              <span className="relative block"><Search className="pointer-events-none absolute left-2 top-1/2 mt-0.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input className={`${inputClass} pl-7`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="test id / source key / package" /></span>
            </label>
            <label className="text-xs font-semibold">Disposition
              <select className={inputClass} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                <option value="ALL">All</option>
                {Object.keys(overview.dispositionTotals).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[960px] text-[11px]">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1">Package</th><th>Phase 2</th><th>Gate</th><th>Disposition</th><th>Open QA</th><th>Media</th><th>Practice A/IP/U</th><th>Rights</th><th>Plan L / P</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.testId} className={`border-t border-border align-top ${selected === r.testId ? 'bg-muted/50' : ''}`}>
                    <td className="py-1.5 pr-2"><span className="font-mono font-semibold">{r.testId}</span><br /><span className="text-muted-foreground">{r.sourceKey}</span></td>
                    <td className="pr-2 font-mono">{r.phase2Status}</td>
                    <td className="pr-2"><div className="flex max-w-[260px] flex-wrap gap-0.5">{GATE_KEYS.map(([k, l]) => <Flag key={k} ok={!!r.gate[k]} label={l} />)}</div>
                      {r.readyExceptHumanQa && <span className="text-[10px] text-amber-700 dark:text-amber-300">ready except human QA</span>}</td>
                    <td className="pr-2 font-mono">{r.disposition}</td>
                    <td className="pr-2 font-mono">{Object.entries(r.openQaByPriority).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}</td>
                    <td className="pr-2">{r.mediaReady}/{r.mediaAssets}{r.imagesAwaitingHumanApproval > 0 ? ` (${r.imagesAwaitingHumanApproval} awaiting)` : ''}</td>
                    <td className="pr-2 font-mono">{r.practiceScopes.AVAILABLE || 0}/{r.practiceScopes.CONTENT_IN_PROGRESS || 0}/{r.practiceScopes.UNAVAILABLE || 0}</td>
                    <td className="pr-2 font-mono">auth {r.projectAuthorization}<br />licence {r.publisherLicence}<br />prov {r.provenanceComplete ? 'ok' : 'gap'}</td>
                    <td className="pr-2 font-mono">{r.localImportOperation} / {r.productionImportOperation}</td>
                    <td><button type="button" className={secondaryButtonClass} onClick={() => setSelected(selected === r.testId ? null : r.testId)} aria-expanded={selected === r.testId}
                      aria-label={`Details of ${r.testId}`}>
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selected && <div className={panelClass}><PackageDetail key={selected} testId={selected} onMessage={onMessage} /></div>}

      <PersistedFormLookup onMessage={onMessage} />
    </div>
  );
};

export default ExamAdminOperationsPanel;
