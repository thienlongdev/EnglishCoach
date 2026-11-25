'use client';

import React, { useEffect, useState } from 'react';
import type { AdminMessage } from './ExamAdminConsole';
import { examAdminApi, getApiErrorMessage } from '@/services/examAdminApi';
import type { EvaluationReport, GoldDataset, RaterAssignment, RaterAssignmentView, RaterRatingSummary } from '@/types/exam-admin';
import { buttonClass, Field, inputClass, JsonBlock, KeyValueList, panelClass, secondaryButtonClass, SectionTitle } from './ExamAdminPrimitives';

function parseJson(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function parseRecords(value: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Evaluation records must be a JSON array');
  return parsed as Array<Record<string, unknown>>;
}

export function ExamAdminRaterPanel({ onMessage }: { onMessage: (message: AdminMessage) => void }) {
  const [consentHash, setConsentHash] = useState('');
  const [consentId, setConsentId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [dataset, setDataset] = useState<GoldDataset | null>(null);
  const [logicalCode, setLogicalCode] = useState('');
  const [datasetVersion, setDatasetVersion] = useState('1');
  const [family, setFamily] = useState<'IELTS' | 'TOEIC'>('IELTS');
  const [skill, setSkill] = useState<'LISTENING' | 'READING' | 'WRITING' | 'SPEAKING'>('WRITING');
  const [rubricVersionId, setRubricVersionId] = useState('');
  const [consentPolicyVersion, setConsentPolicyVersion] = useState('human-rating-v1');
  const [provenanceStatement, setProvenanceStatement] = useState('Human-rated dataset created from consented runtime responses; operators must attach source evidence.');
  const [responseId, setResponseId] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const [split, setSplit] = useState('DEVELOPMENT');
  const [raterUserId, setRaterUserId] = useState('');
  const [assignments, setAssignments] = useState<RaterAssignment[]>([]);
  const [assignmentId, setAssignmentId] = useState('');
  const [assignmentView, setAssignmentView] = useState<RaterAssignmentView | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [ratings, setRatings] = useState<RaterRatingSummary[]>([]);
  const [criterionScores, setCriterionScores] = useState('{\n  "task_response": 0\n}');
  const [overallScore, setOverallScore] = useState('');
  const [confidence, setConfidence] = useState('');
  const [ratingHash, setRatingHash] = useState('');
  const [selectedRatingId, setSelectedRatingId] = useState('');
  const [finalScores, setFinalScores] = useState('{}');
  const [disagreementReason, setDisagreementReason] = useState('');
  const [decisionHash, setDecisionHash] = useState('');
  const [scorerName, setScorerName] = useState('');
  const [scorerVersion, setScorerVersion] = useState('');
  const [lockedTestHash, setLockedTestHash] = useState('');
  const [evaluationRecords, setEvaluationRecords] = useState('[\n  {\n    "memberId": "",\n    "split": "TEST",\n    "criterion": "overall",\n    "humanScore": 0,\n    "aiScore": 0,\n    "abstained": false,\n    "subgroup": "all"\n  }\n]');
  const [evaluation, setEvaluation] = useState<EvaluationReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try { await action(); } catch (error) { onMessage({ type: 'error', text: getApiErrorMessage(error) }); }
    finally { setBusy(null); }
  };

  const giveConsent = () => runAction('consent', async () => {
    if (!consentHash.trim()) throw new Error('Enter the signed consent evidence hash');
    const result = await examAdminApi.createConsent({ status: 'GRANTED', consentHash: consentHash.trim() }, true);
    setConsentId(result.consentId);
    onMessage({ type: 'success', text: `Human-rating consent recorded for the authenticated user: ${result.consentId}.` });
  });

  const createDataset = () => runAction('createDataset', async () => {
    const result = await examAdminApi.createGoldDataset({ logicalCode, version: Number(datasetVersion), family, skill, rubricVersionId: rubricVersionId || undefined, consentPolicyVersion, provenanceStatement });
    setDatasetId(result.datasetId);
    onMessage({ type: 'success', text: `Created gold dataset ${result.datasetId} in ${result.status}.` });
  });

  const loadDataset = () => runAction('loadDataset', async () => {
    if (!datasetId.trim()) throw new Error('Enter a dataset UUID');
    const result = await examAdminApi.getGoldDataset(datasetId.trim());
    setDataset(result);
    onMessage({ type: 'success', text: `Loaded dataset ${result.id}: ${result.status}.` });
  });

  const addMember = () => runAction('member', async () => {
    if (!datasetId.trim() || !responseId.trim() || !attemptId.trim() || !consentId.trim()) throw new Error('Dataset, response, attempt, and the authenticated participant consent ID are required');
    const result = await examAdminApi.addGoldMember(datasetId.trim(), { responseId: responseId.trim(), attemptId: attemptId.trim(), consentId: consentId.trim(), split });
    onMessage({ type: 'success', text: `Added consent-linked response member ${result.memberId}.` });
  });

  const lockDataset = () => runAction('lockDataset', async () => {
    if (!datasetId.trim()) throw new Error('Enter a dataset UUID');
    await examAdminApi.lockGoldDataset(datasetId.trim());
    onMessage({ type: 'success', text: 'Dataset locked; membership and assignments are now server controlled.' });
    const refreshed = await examAdminApi.getGoldDataset(datasetId.trim());
    setDataset(refreshed);
  });

  const assign = () => runAction('assign', async () => {
    if (!datasetId.trim() || !responseId.trim() || !attemptId.trim() || !raterUserId.trim()) throw new Error('Dataset, response, attempt, and a real authenticated rater user ID are required');
    const result = await examAdminApi.assignRater(datasetId.trim(), { responseId: responseId.trim(), attemptId: attemptId.trim(), raterUserId: Number(raterUserId) });
    setAssignmentId(result.assignmentId);
    onMessage({ type: 'success', text: `Blind assignment ${result.assignmentId} created for the selected authenticated rater.` });
  });

  const listAssignments = () => runAction('listAssignments', async () => {
    if (!datasetId.trim()) throw new Error('Enter a dataset UUID');
    const result = await examAdminApi.getMyAssignments(datasetId.trim());
    setAssignments(result);
    onMessage({ type: 'success', text: `Loaded ${result.length} assignments for the current authenticated rater.` });
  });

  const openAssignment = () => runAction('assignmentView', async () => {
    if (!assignmentId.trim()) throw new Error('Enter an assignment UUID');
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    setRatings([]);
    const result = await examAdminApi.getAssignmentView(assignmentId.trim());
    setAssignmentView(result);
    setResponseId(result.assignment.responseId);
    setAttemptId(result.assignment.attemptId);
    setRubricVersionId(result.rubricVersionId || '');
    onMessage({ type: 'success', text: 'Loaded the assigned original response and rubric context. AI scores are intentionally absent.' });
  });

  const loadRecording = () => runAction('recording', async () => {
    if (!assignmentId.trim()) throw new Error('Open an assignment before requesting its recording');
    const blob = await examAdminApi.getAssignmentRecording(assignmentId.trim());
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(URL.createObjectURL(blob));
    onMessage({ type: 'success', text: 'Loaded the assigned recording through the measurement-scoped authorization check.' });
  });

  const loadRatings = () => runAction('ratings', async () => {
    if (!datasetId.trim() || !responseId.trim()) throw new Error('Dataset and response IDs are required to load adjudication ratings');
    const result = await examAdminApi.getAdjudicationRatings(datasetId.trim(), responseId.trim());
    setRatings(result);
    onMessage({ type: result.length > 0 ? 'success' : 'error', text: result.length > 0 ? `Loaded ${result.length} submitted rating(s); rater identities remain hidden.` : 'No ratings are visible. Assigned raters stay blind, or two independent ratings have not been submitted yet.' });
  });

  const submitRating = () => runAction('submitRating', async () => {
    if (!assignmentId.trim()) throw new Error('Enter an assignment UUID');
    const scores = parseJson(criterionScores, 'Criterion scores');
    await examAdminApi.submitRating(assignmentId.trim(), { rubricVersionId: rubricVersionId || undefined, criterionScores: scores, overallScore: overallScore === '' ? undefined : Number(overallScore), confidence: confidence === '' ? undefined : Number(confidence), ratingHash: ratingHash || undefined });
    onMessage({ type: 'success', text: 'Rating submitted under the authenticated assignment owner; rater identity came from the server session.' });
  });

  const adjudicate = () => runAction('adjudicate', async () => {
    if (!datasetId.trim() || !responseId.trim() || !selectedRatingId.trim()) throw new Error('Dataset, response, and the selected submitted rating UUID are required');
    await examAdminApi.adjudicate(datasetId.trim(), { responseId: responseId.trim(), selectedRatingId: selectedRatingId.trim(), finalScores: parseJson(finalScores, 'Final scores'), disagreementReason, decisionHash });
    onMessage({ type: 'success', text: 'Adjudication recorded with disagreement reason and decision evidence.' });
  });

  const evaluate = () => runAction('evaluate', async () => {
    if (!datasetId.trim() || !scorerName.trim() || !scorerVersion.trim() || !lockedTestHash.trim()) throw new Error('Dataset, scorer name/version, and immutable locked-test hash are required');
    const result = await examAdminApi.evaluate(datasetId.trim(), { scorerName, scorerVersion, lockedTestHash, records: parseRecords(evaluationRecords) });
    setEvaluation(result);
    onMessage({ type: result.overall.status === 'INSUFFICIENT' ? 'error' : 'success', text: `Scorer evaluation returned ${result.overall.status}; the server checked split and locked-test hygiene.` });
  });

  return (
    <div className="space-y-5">
      <section className={panelClass}>
        <SectionTitle title="Authenticated human-rating consent" description="This button records consent for the signed-in user only. An operator cannot forge consent for a learner or rater by supplying another identity." />
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"><Field label="Signed consent evidence hash"><input value={consentHash} onChange={(event) => setConsentHash(event.target.value)} className={inputClass} placeholder="hash of the consent record" /></Field><button type="button" className={buttonClass} disabled={busy !== null} onClick={giveConsent}>{busy === 'consent' ? 'Recording…' : 'Record my human-rating consent'}</button></div>
        {consentId && <p className="mt-3 break-all text-xs text-muted-foreground">Consent ID: <span className="font-mono text-foreground">{consentId}</span></p>}
      </section>

      <section className={panelClass}>
        <SectionTitle title="Gold dataset lifecycle" description="Dataset membership must reference a consented runtime response. Locking is required before assignment, adjudication, and scorer evaluation." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4"><Field label="Dataset ID"><input value={datasetId} onChange={(event) => setDatasetId(event.target.value)} className={inputClass} placeholder="returned UUID" /></Field><Field label="Logical code"><input value={logicalCode} onChange={(event) => setLogicalCode(event.target.value)} className={inputClass} placeholder="ielts-writing-pilot" /></Field><Field label="Version"><input type="number" min="1" value={datasetVersion} onChange={(event) => setDatasetVersion(event.target.value)} className={inputClass} /></Field><Field label="Consent policy"><input value={consentPolicyVersion} onChange={(event) => setConsentPolicyVersion(event.target.value)} className={inputClass} /></Field><Field label="Family"><select value={family} onChange={(event) => setFamily(event.target.value as 'IELTS' | 'TOEIC')} className={inputClass}><option value="IELTS">IELTS</option><option value="TOEIC">TOEIC</option></select></Field><Field label="Skill"><select value={skill} onChange={(event) => setSkill(event.target.value as typeof skill)} className={inputClass}><option value="LISTENING">LISTENING</option><option value="READING">READING</option><option value="WRITING">WRITING</option><option value="SPEAKING">SPEAKING</option></select></Field><Field label="Rubric version ID" hint="optional"><input value={rubricVersionId} onChange={(event) => setRubricVersionId(event.target.value)} className={inputClass} placeholder="UUID" /></Field><Field label="Provenance"><input value={provenanceStatement} onChange={(event) => setProvenanceStatement(event.target.value)} className={inputClass} /></Field></div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy !== null} onClick={createDataset}>{busy === 'createDataset' ? 'Creating…' : 'Create draft dataset'}</button><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={loadDataset}>{busy === 'loadDataset' ? 'Loading…' : 'Load dataset'}</button><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={lockDataset}>{busy === 'lockDataset' ? 'Locking…' : 'Lock dataset'}</button></div>
        {dataset && <div className="mt-4"><KeyValueList values={[["Status", dataset.status], ["Family/skill", `${dataset.family}/${dataset.skill}`], ["Policy", dataset.consentPolicyVersion], ["Provenance", dataset.provenanceStatement], ["Locked at", dataset.lockedAt]]} /></div>}
      </section>

      <section className={panelClass}>
        <SectionTitle title="Consent-linked members and blind assignments" description="The operator supplies existing response/attempt identifiers and a real rater account. The backend rejects missing consent, unlocked datasets, duplicate assignment, and self-assignment." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4"><Field label="Response ID"><input value={responseId} onChange={(event) => setResponseId(event.target.value)} className={inputClass} placeholder="runtime response UUID" /></Field><Field label="Attempt ID"><input value={attemptId} onChange={(event) => setAttemptId(event.target.value)} className={inputClass} placeholder="runtime attempt UUID" /></Field><Field label="Consent ID"><input value={consentId} onChange={(event) => setConsentId(event.target.value)} className={inputClass} placeholder="recorded by participant" /></Field><Field label="Split"><select value={split} onChange={(event) => setSplit(event.target.value)} className={inputClass}><option value="DEVELOPMENT">DEVELOPMENT</option><option value="CALIBRATION">CALIBRATION</option><option value="VALIDATION">VALIDATION</option><option value="TEST">TEST (locked test)</option></select></Field><Field label="Rater user ID" hint="real account"><input value={raterUserId} onChange={(event) => setRaterUserId(event.target.value)} className={inputClass} placeholder="numeric user ID" /></Field></div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy !== null} onClick={addMember}>{busy === 'member' ? 'Adding…' : 'Add consented member'}</button><button type="button" className={buttonClass} disabled={busy !== null} onClick={assign}>{busy === 'assign' ? 'Assigning…' : 'Create blind assignment'}</button><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={listAssignments}>{busy === 'listAssignments' ? 'Loading…' : 'Load my assignments'}</button></div>
        {assignments.length > 0 && <div className="mt-4 overflow-x-auto rounded-md border border-border"><table className="w-full min-w-[700px] text-left text-[11px]"><thead className="bg-muted/50 text-muted-foreground"><tr><th className="p-2">Assignment</th><th className="p-2">Response</th><th className="p-2">Family/skill</th><th className="p-2">Blind</th><th className="p-2">Status</th></tr></thead><tbody>{assignments.map((item) => <tr key={item.id} className="border-t border-border"><td className="p-2"><button type="button" className="font-mono text-primary underline" onClick={() => { setAssignmentId(item.id); }}>{item.id}</button></td><td className="p-2 font-mono">{item.responseId}</td><td className="p-2">{item.family}/{item.skill}</td><td className="p-2">{String(item.blindToOtherRatings)}</td><td className="p-2">{item.status}</td></tr>)}</tbody></table></div>}
      </section>

      <section className={panelClass}>
        <SectionTitle title="Rater view and independent rating" description="The assignment view contains the original task, response, rubric, and recording/stimulus references. It deliberately omits AI scores and other rater submissions." />
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"><Field label="Assignment ID"><input value={assignmentId} onChange={(event) => setAssignmentId(event.target.value)} className={inputClass} placeholder="your assigned UUID" /></Field><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={openAssignment}>{busy === 'assignmentView' ? 'Loading…' : 'Open blind assignment'}</button></div>
        {assignmentView && <div className="mt-4 space-y-3"><KeyValueList values={[["Item", assignmentView.itemId], ["Skill", assignmentView.skill], ["Interaction", assignmentView.interactionType], ["Rubric", assignmentView.rubricVersionId], ["Recording reference", assignmentView.recordingId || 'none returned']]} /><div className="grid gap-3 md:grid-cols-2"><div><h3 className="mb-1 text-xs font-bold text-foreground">Original prompt</h3><p className="whitespace-pre-wrap rounded-md border border-border p-3 text-xs text-foreground">{assignmentView.prompt || 'No prompt text returned.'}</p></div><div><h3 className="mb-1 text-xs font-bold text-foreground">Original response</h3><p className="whitespace-pre-wrap rounded-md border border-border p-3 text-xs text-foreground">{assignmentView.textResponse || JSON.stringify(assignmentView.responsePayload)}</p></div></div>{assignmentView.recordingId && <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300"><div>Recording reference: <span className="font-mono text-foreground">{assignmentView.recordingId}</span>. The server checks assignment ownership or independent adjudicator status, dataset membership, response linkage, sealed state, and current consent before streaming.</div><button type="button" className={`${secondaryButtonClass} mt-2`} disabled={busy !== null} onClick={loadRecording}>{busy === 'recording' ? 'Loading audio…' : 'Load authorized recording'}</button>{recordingUrl && <audio controls src={recordingUrl} className="mt-3 w-full" />}</div>}{!assignmentView.recordingId && <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">No recording reference was returned for this response; rating can continue for text/structured responses.</p>}<JsonBlock value={{ stimulusAssets: assignmentView.stimulusAssets, optionDefinitions: assignmentView.optionDefinitions }} /></div>}
        <div className="mt-5 grid gap-3 md:grid-cols-2"><Field label="Criterion scores (JSON object)"><textarea value={criterionScores} onChange={(event) => setCriterionScores(event.target.value)} className={`${inputClass} min-h-28 font-mono text-xs`} /></Field><div className="grid gap-3"><Field label="Overall score"><input value={overallScore} onChange={(event) => setOverallScore(event.target.value)} className={inputClass} placeholder="numeric score" /></Field><Field label="Confidence"><input value={confidence} onChange={(event) => setConfidence(event.target.value)} className={inputClass} placeholder="optional numeric confidence" /></Field><Field label="Rating evidence hash"><input value={ratingHash} onChange={(event) => setRatingHash(event.target.value)} className={inputClass} placeholder="hash of signed rating evidence" /></Field></div></div>
        <button type="button" className={`${buttonClass} mt-3`} disabled={busy !== null} onClick={submitRating}>{busy === 'submitRating' ? 'Submitting…' : 'Submit independent rating'}</button>
      </section>

      <section className={panelClass}>
        <SectionTitle title="Adjudication and scorer evaluation" description="Adjudication requires two independent submitted ratings. Evaluation accepts only a server-locked test hash and disjoint, explicit split records." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4"><Field label="Selected rating ID"><input value={selectedRatingId} onChange={(event) => setSelectedRatingId(event.target.value)} className={inputClass} placeholder="submitted rating UUID" /></Field><Field label="Decision hash"><input value={decisionHash} onChange={(event) => setDecisionHash(event.target.value)} className={inputClass} placeholder="evidence hash" /></Field><Field label="Disagreement reason"><input value={disagreementReason} onChange={(event) => setDisagreementReason(event.target.value)} className={inputClass} placeholder="required for disagreement" /></Field><Field label="Final scores JSON"><textarea value={finalScores} onChange={(event) => setFinalScores(event.target.value)} className={`${inputClass} min-h-12 font-mono text-xs`} /></Field></div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={loadRatings}>{busy === 'ratings' ? 'Loading…' : 'Load submitted ratings (adjudicator)'}</button><button type="button" className={buttonClass} disabled={busy !== null} onClick={adjudicate}>{busy === 'adjudicate' ? 'Adjudicating…' : 'Record adjudication'}</button></div>
        {ratings.length > 0 && <div className="mt-3 space-y-2 rounded-md border border-border p-3"><p className="text-xs text-muted-foreground">Rater identities are omitted. Select a rating only after reviewing the independent submissions.</p>{ratings.map((rating) => <button type="button" key={rating.id} onClick={() => setSelectedRatingId(rating.id)} className={`block w-full rounded-md border p-3 text-left text-xs ${selectedRatingId === rating.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'}`}><span className="font-mono text-primary">{rating.id}</span><span className="ml-2 text-muted-foreground">submitted {rating.submittedAt}</span><div className="mt-1 text-foreground">Overall: {rating.overallScore ?? '—'} · confidence: {rating.confidence ?? '—'}</div><div className="mt-1 font-mono text-[10px] text-muted-foreground">{JSON.stringify(rating.criterionScores)}</div></button>)}</div>}
        <div className="mt-6 grid gap-3 md:grid-cols-4"><Field label="Scorer name"><input value={scorerName} onChange={(event) => setScorerName(event.target.value)} className={inputClass} /></Field><Field label="Scorer version"><input value={scorerVersion} onChange={(event) => setScorerVersion(event.target.value)} className={inputClass} /></Field><Field label="Locked test hash"><input value={lockedTestHash} onChange={(event) => setLockedTestHash(event.target.value)} className={inputClass} /></Field><Field label="Records JSON"><textarea value={evaluationRecords} onChange={(event) => setEvaluationRecords(event.target.value)} className={`${inputClass} min-h-20 font-mono text-xs`} /></Field></div>
        <button type="button" className={`${buttonClass} mt-3`} disabled={busy !== null} onClick={evaluate}>{busy === 'evaluate' ? 'Evaluating…' : 'Evaluate scorer'}</button>
        {evaluation && (<div className="mt-4 space-y-3"><KeyValueList values={[["Status", evaluation.overall.status], ["Sample", evaluation.overall.sampleSize], ["Scored", evaluation.overall.scoredCount], ["Abstained", evaluation.overall.abstainedCount], ["MAE", evaluation.overall.mae], ["RMSE", evaluation.overall.rmse], ["Exact", evaluation.overall.exactRate], ["Adjacent", evaluation.overall.adjacentRate], ["Kappa", evaluation.overall.kappa], ["Correlation", evaluation.overall.correlation], ["Abstention", evaluation.overall.abstentionRate]]} />{evaluation.overall.reason && <p className="text-xs text-amber-700 dark:text-amber-300">{evaluation.overall.reason}</p>}{evaluation.hygieneFlags.length > 0 && <JsonBlock value={evaluation.hygieneFlags} />}</div>)}
      </section>
    </div>
  );
}
