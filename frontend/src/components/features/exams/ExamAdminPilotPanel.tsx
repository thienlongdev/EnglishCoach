'use client';

import React, { useState } from 'react';
import type { AdminMessage } from './ExamAdminConsole';
import { examAdminApi, getApiErrorMessage } from '@/services/examAdminApi';
import type { AnalysisReport, MeasurementEvent, RunView } from '@/types/exam-admin';
import { buttonClass, Field, inputClass, JsonBlock, KeyValueList, panelClass, secondaryButtonClass, SectionTitle } from './ExamAdminPrimitives';

export function ExamAdminPilotPanel({ onMessage }: { onMessage: (message: AdminMessage) => void }) {
  const [attemptId, setAttemptId] = useState('');
  const [attemptIds, setAttemptIds] = useState('');
  const [events, setEvents] = useState<MeasurementEvent[]>([]);
  const [family, setFamily] = useState<'IELTS' | 'TOEIC'>('IELTS');
  const [skill, setSkill] = useState('');
  const [formId, setFormId] = useState('');
  const [consentPolicyVersion, setConsentPolicyVersion] = useState('pilot-v1');
  const [runId, setRunId] = useState('');
  const [run, setRun] = useState<RunView | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try { await action(); } catch (error) { onMessage({ type: 'error', text: getApiErrorMessage(error) }); }
    finally { setBusy(null); }
  };

  const collect = () => runAction('collect', async () => {
    if (!attemptId.trim()) throw new Error('Enter an existing runtime attempt UUID');
    const result = await examAdminApi.collectAttempt(attemptId.trim());
    setAttemptIds((current) => current.trim() ? `${current.trim()}\n${attemptId.trim()}` : attemptId.trim());
    const exported = await examAdminApi.getAttemptEvents(attemptId.trim());
    setEvents(exported);
    onMessage({ type: 'success', text: `Collected ${result.eventIds.length} runtime event(s) for ${result.attemptId}. Evidence: ${result.evidenceClass}.` });
  });

  const loadEvents = () => runAction('events', async () => {
    if (!attemptId.trim()) throw new Error('Enter an existing runtime attempt UUID');
    const result = await examAdminApi.getAttemptEvents(attemptId.trim());
    setEvents(result);
    onMessage({ type: 'success', text: `Loaded ${result.length} persisted event(s) from the runtime attempt.` });
  });

  const createRun = () => runAction('createRun', async () => {
    const ids = attemptIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('Add at least one existing attempt UUID');
    const result = await examAdminApi.createRun({ family, skill: skill || undefined, formId: formId || undefined, attemptIds: ids, consentPolicyVersion });
    setRunId(result.runId);
    onMessage({ type: 'success', text: `Created measurement run ${result.runId} in ${result.status}.` });
  });

  const loadRun = () => runAction('loadRun', async () => {
    if (!runId.trim()) throw new Error('Enter a measurement run UUID');
    const result = await examAdminApi.getRun(runId.trim());
    setRun(result);
    const exported = await examAdminApi.getRunEvents(runId.trim());
    setEvents(exported);
    onMessage({ type: 'success', text: `Loaded run ${result.run.id}: ${result.run.cleanCount} clean / ${result.run.rawCount} raw / ${result.run.excludedCount} excluded.` });
  });

  const calculate = () => runAction('calculate', async () => {
    if (!runId.trim()) throw new Error('Enter a measurement run UUID');
    const result = await examAdminApi.calculateRun(runId.trim());
    setReport(result);
    onMessage({ type: result.status === 'INSUFFICIENT' ? 'error' : 'success', text: `CTT calculation returned ${result.status}: ${result.cleanCount} clean observations.` });
  });

  return (
    <div className="space-y-5">
      <section className={panelClass}>
        <SectionTitle title="Collect from real runtime attempts" description="Collection reads the existing attempt, submission, response, form, answer-spec, exposure, and consent records. The operator cannot mark an import as a learner or human evidence class." />
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <Field label="Attempt UUID"><input value={attemptId} onChange={(event) => setAttemptId(event.target.value)} className={inputClass} placeholder="existing learner attempt UUID" /></Field>
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={collect}>{busy === 'collect' ? 'Collecting…' : 'Collect and export'}</button>
          <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={loadEvents}>{busy === 'events' ? 'Loading…' : 'Load events'}</button>
        </div>
        {events.length > 0 && <div className="mt-4 overflow-x-auto rounded-md border border-border"><table className="w-full min-w-[760px] text-left text-[11px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2">Event</th><th className="p-2">Item</th><th className="p-2">Outcome</th><th className="p-2">Exposure</th><th className="p-2">Consent</th><th className="p-2">Evidence</th></tr></thead><tbody>{events.map((event) => <tr key={event.id} className="border-t border-border"><td className="p-2 font-mono">{event.id}</td><td className="p-2 font-mono">{event.itemId}</td><td className="p-2">{event.outcomeStatus}</td><td className="p-2">{event.exposureStatus}</td><td className="p-2">{event.consentStatus}</td><td className="p-2">{event.evidenceClass}</td></tr>)}</tbody></table></div>}
      </section>

      <section className={panelClass}>
        <SectionTitle title="Create and analyze a measurement run" description="Runs preserve raw, clean, and excluded counts plus the exact input hash and consent-policy version. CTT results fail closed when the sample or variance is insufficient." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <Field label="Family"><select value={family} onChange={(event) => setFamily(event.target.value as 'IELTS' | 'TOEIC')} className={inputClass}><option value="IELTS">IELTS</option><option value="TOEIC">TOEIC</option></select></Field>
          <Field label="Skill" hint="optional"><select value={skill} onChange={(event) => setSkill(event.target.value)} className={inputClass}><option value="">All skills</option><option value="LISTENING">LISTENING</option><option value="READING">READING</option><option value="WRITING">WRITING</option><option value="SPEAKING">SPEAKING</option></select></Field>
          <Field label="Form ID" hint="optional"><input value={formId} onChange={(event) => setFormId(event.target.value)} className={inputClass} placeholder="imported form UUID" /></Field>
          <Field label="Consent policy"><input value={consentPolicyVersion} onChange={(event) => setConsentPolicyVersion(event.target.value)} className={inputClass} /></Field>
          <Field label="Attempt UUIDs" hint="one per line"><textarea value={attemptIds} onChange={(event) => setAttemptIds(event.target.value)} className={`${inputClass} min-h-10`} placeholder="existing attempts" /></Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy !== null} onClick={createRun}>{busy === 'createRun' ? 'Creating…' : 'Create raw run'}</button></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"><Field label="Run UUID"><input value={runId} onChange={(event) => setRunId(event.target.value)} className={inputClass} placeholder="run returned by server" /></Field><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={loadRun}>{busy === 'loadRun' ? 'Loading…' : 'Load run'}</button><button type="button" className={buttonClass} disabled={busy !== null} onClick={calculate}>{busy === 'calculate' ? 'Calculating…' : 'Calculate CTT'}</button></div>
      </section>

      {(run || report) && <section className={panelClass}>
        <SectionTitle title="Measurement evidence" description="Inspect the server report before any calibration package is proposed." />
        {run && <KeyValueList values={[["Run", run.run.id], ["Status", run.run.status], ["Family", run.run.family], ["Raw", run.run.rawCount], ["Clean", run.run.cleanCount], ["Excluded", run.run.excludedCount], ["Input hash", run.run.inputHash], ["Consent policy", run.run.consentPolicyVersion]]} />}
        {report && <div className="mt-4 space-y-3"><KeyValueList values={[["Report", report.runId], ["Status", report.status], ["Raw", report.rawCount], ["Clean", report.cleanCount], ["Excluded", report.excludedCount], ["Reliability", report.reliability.status], ["KR-20", report.reliability.kr20]]} />{report.hygieneFlags.length > 0 && <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"><strong>Hygiene flags:</strong> {report.hygieneFlags.join(' · ')}</div>}<div className="overflow-x-auto rounded-md border border-border"><table className="w-full min-w-[700px] text-left text-[11px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2">Item</th><th className="p-2">n</th><th className="p-2">p</th><th className="p-2">item-rest r</th><th className="p-2">omission</th><th className="p-2">time median</th><th className="p-2">status</th></tr></thead><tbody>{report.itemStatistics.map((item) => <tr key={item.itemId} className="border-t border-border"><td className="p-2 font-mono">{item.itemId}</td><td className="p-2">{item.sampleSize}</td><td className="p-2">{item.pValue ?? '—'}</td><td className="p-2">{item.itemRestPointBiserial ?? '—'}</td><td className="p-2">{item.omissionRate ?? '—'}</td><td className="p-2">{item.medianResponseTimeMs ?? '—'}</td><td className="p-2">{item.calculationStatus}</td></tr>)}</tbody></table></div></div>}
        {run && run.items.length === 0 && !report && <p className="mt-4 text-xs text-muted-foreground">The server returned no item statistics yet. Calculate the run after its raw events are eligible.</p>}
      </section>}

      {events.length > 0 && <details className={`${panelClass} text-xs`}><summary className="cursor-pointer font-semibold text-foreground">View immutable event payloads ({events.length})</summary><div className="mt-3"><JsonBlock value={events} /></div></details>}
    </div>
  );
}

