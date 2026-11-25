'use client';

import React, { useMemo, useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import type { AdminMessage } from './ExamAdminConsole';
import { examAdminApi, getApiErrorMessage } from '@/services/examAdminApi';
import { parseContentBatch } from '@/lib/exams/contentBatch';
import type { AdminFormSummary, AdminSourceSummary, ExamContentPackage, ImportResult, ValidationResult } from '@/types/exam-admin';
import { buttonClass, Field, inputClass, JsonBlock, KeyValueList, panelClass, secondaryButtonClass, SectionTitle } from './ExamAdminPrimitives';

function parsePackage(value: string): ExamContentPackage {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Package JSON must be an object');
  return parsed as ExamContentPackage;
}

function validationFrom(error: unknown): ValidationResult | undefined {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const candidate = data as Partial<ValidationResult>;
  return typeof candidate.valid === 'boolean' && Array.isArray(candidate.errors)
    ? { valid: candidate.valid, computedContentHash: candidate.computedContentHash, errors: candidate.errors }
    : undefined;
}

export function ExamAdminContentPanel({ onMessage }: { onMessage: (message: AdminMessage) => void }) {
  const { locale } = useLanguage();
  const [packageText, setPackageText] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [forms, setForms] = useState<AdminFormSummary[]>([]);
  const [sources, setSources] = useState<AdminSourceSummary[]>([]);
  const [formId, setFormId] = useState('');
  const [packageId, setPackageId] = useState('');
  const [packageVersion, setPackageVersion] = useState('1');
  const [gate, setGate] = useState('CONTENT_QA');
  const [decision, setDecision] = useState('APPROVED');
  const [reviewHash, setReviewHash] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [batchText, setBatchText] = useState('');
  const [batchResults, setBatchResults] = useState<Array<{ index: number; packageId: string; status: string; detail: string }>>([]);
  const [toeicBatch, setToeicBatch] = useState<Awaited<ReturnType<typeof examAdminApi.getToeicPublicationBatch>> | null>(null);

  const parsedPackage = useMemo(() => {
    try { return packageText.trim() ? parsePackage(packageText) : null; } catch { return null; }
  }, [packageText]);

  const resolvedFormId = formId || importResult?.formId || (parsedPackage?.form as { id?: string } | undefined)?.id || '';
  const resolvedPackageId = packageId || importResult?.packageId || '';
  const resolvedPackageVersion = Number(packageVersion || importResult?.packageVersion || 1);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try { await action(); } catch (error) { onMessage({ type: 'error', text: getApiErrorMessage(error) }); }
    finally { setBusy(null); }
  };

  const validate = () => run('validate', async () => {
    let pkg: ExamContentPackage;
    try { pkg = parsePackage(packageText); } catch (error) { throw error; }
    try {
      const result = await examAdminApi.validatePackage(pkg);
      setValidation(result);
      onMessage({ type: result.valid ? 'success' : 'error', text: result.valid ? `Package is valid. Content hash: ${result.computedContentHash || 'server returned no hash'}.` : 'Package failed validation; import is disabled.' });
    } catch (error) {
      const result = validationFrom(error);
      if (result) {
        setValidation(result);
        onMessage({ type: 'error', text: 'Package failed server validation; review the exact errors below.' });
        return;
      }
      throw error;
    }
  });

  const importPackage = () => run('import', async () => {
    if (!validation?.valid) throw new Error('Validate the package successfully before importing');
    const result = await examAdminApi.importPackage(parsePackage(packageText));
    setImportResult(result);
    setPackageId(result.packageId);
    setPackageVersion(String(result.packageVersion));
    setFormId(result.formId);
    setReviewHash(result.contentHash);
    onMessage({ type: 'success', text: `${result.status} ${result.packageId} v${result.packageVersion}; form ${result.formId}.` });
  });

  const loadStatus = () => run('status', async () => {
    if (!resolvedPackageId) throw new Error('Enter or import a package ID first');
    const result = await examAdminApi.getImportStatus(resolvedPackageId, resolvedPackageVersion);
    setStatus(result);
    onMessage({ type: 'success', text: 'Loaded the server import ledger record.' });
  });

  const loadWorkQueues = () => run('queues', async () => {
    const [nextForms, nextSources] = await Promise.all([examAdminApi.listForms(), examAdminApi.listSources()]);
    setForms(nextForms);
    setSources(nextSources);
    onMessage({ type: 'success', text: `Loaded ${nextForms.length} form records and ${nextSources.length} source records.` });
  });

  const submitReview = () => run('review', async () => {
    if (!resolvedFormId) throw new Error('A form ID is required for a review decision');
    if (!reviewHash) throw new Error('A server content hash is required for a review decision');
    await examAdminApi.submitReview(resolvedFormId, { gate, decision, hash: reviewHash, notes });
    onMessage({ type: 'success', text: `${gate} ${decision.toLowerCase()} for form ${resolvedFormId}.` });
  });

  const release = (operation: 'publish' | 'retire') => run(operation, async () => {
    if (!resolvedFormId) throw new Error('A form ID is required');
    const result = operation === 'publish' ? await examAdminApi.publishForm(resolvedFormId) : await examAdminApi.retireForm(resolvedFormId);
    onMessage({ type: 'success', text: `${operation === 'publish' ? 'Published' : 'Retired'} form ${String(result.formId || resolvedFormId)} after server gate checks.` });
  });

  const releaseContentBatch = () => run('content-batch', async () => {
    const packages = parseContentBatch(batchText);
    const results: typeof batchResults = [];
    setBatchResults([]);
    for (const [index, { pkg, json }] of packages.entries()) {
      const packageId = String((pkg.manifest as { packageId?: string })?.packageId || index + 1);
      try {
        const receipts = await examAdminApi.releaseQualifiedCorpusPractice(0, json);
        if (receipts.length !== 1 || receipts[0].packageId !== packageId)
          throw new Error('Invalid content release receipt');
        const receipt = receipts[0];
        results.push({ index: index + 1, packageId, status: receipt.operation, detail: receipt.formId || '' });
      } catch (error) {
        results.push({ index: index + 1, packageId, status: 'FAILED', detail: getApiErrorMessage(error) });
      }
      setBatchResults([...results]);
    }
    const failed = results.filter((result) => result.status === 'FAILED').length;
    onMessage({ type: failed ? 'error' : 'success', text: locale === 'vi'
      ? `Đã xử lý ${results.length} gói; ${failed} gói thất bại. Xem kết quả bên dưới.`
      : `Processed ${results.length} packages; ${failed} failed. See the results below.` });
  });

  return (
    <div className="space-y-5">
      <section className={panelClass}>
        <SectionTitle title={locale === 'vi' ? 'Phát hành đề TOEIC' : 'Publish TOEIC editions'} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} disabled={busy !== null}
            onClick={() => run('toeic-status', async () => setToeicBatch(await examAdminApi.getToeicPublicationBatch()))}>
            {locale === 'vi' ? 'Kiểm tra lô TOEIC' : 'Check TOEIC batch'}
          </button>
          {toeicBatch && toeicBatch.pending.length > 0 && !toeicBatch.progress.running && (
            <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => run('toeic-publish', async () => {
              await examAdminApi.publishToeicBatch(toeicBatch.pending);
              setToeicBatch(await examAdminApi.getToeicPublicationBatch());
            })}>{locale === 'vi' ? 'Phát hành' : 'Publish'} {toeicBatch.pending.length} {locale === 'vi' ? 'đề TOEIC' : 'TOEIC editions'}</button>
          )}
        </div>
        {toeicBatch && <p className="mt-2 text-sm" role="status">
          {locale === 'vi' ? 'Chờ phát hành' : 'Pending'} {toeicBatch.pending.length}
          {toeicBatch.progress.total > 0 && <> · {toeicBatch.progress.published}/{toeicBatch.progress.total} {locale === 'vi' ? 'đã phát hành' : 'published'}
            {' · '}{Object.keys(toeicBatch.progress.failures).length} {locale === 'vi' ? 'lỗi' : 'failed'}</>}
        </p>}
      </section>
      <section className={panelClass}>
        <SectionTitle title={locale === 'vi' ? 'Phát hành lô nội dung luyện tập' : 'Release Practice content batch'} description={locale === 'vi' ? 'Tải tệp JSON gồm tối đa 50 gói. Máy chủ kiểm tra cấu trúc, đáp án, phương tiện và quyền sử dụng từng gói. Gói thất bại được ghi lại và lô tiếp tục.' : 'Load a JSON array of up to 50 packages. The server checks each package’s structure, answers, media and usage rights. Failed packages are recorded and the batch continues.'} />
        <input type="file" accept=".json,application/json" disabled={busy !== null} aria-label={locale === 'vi' ? 'Tệp lô nội dung' : 'Content batch file'} onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void run('load-batch', async () => { setBatchText(await file.text()); setBatchResults([]); });
        }} className="mb-3 block text-sm" />
        <textarea value={batchText} disabled={busy !== null} onChange={(event) => { setBatchText(event.target.value); setBatchResults([]); }} aria-label={locale === 'vi' ? 'JSON lô nội dung' : 'Content batch JSON'} className={`${inputClass} min-h-32 font-mono text-xs`} placeholder='[{"manifest": ...}]' />
        <button type="button" className={`${buttonClass} mt-3`} disabled={busy !== null || !batchText.trim()} onClick={releaseContentBatch}>{busy === 'content-batch' ? (locale === 'vi' ? 'Đang phát hành…' : 'Releasing…') : (locale === 'vi' ? 'Kiểm tra và phát hành lô' : 'Check and release batch')}</button>
        {batchResults.length > 0 && <div className="mt-3 space-y-2" role="status">{batchResults.map((result) => <div key={result.index} className="rounded-md border border-border p-3 text-xs"><div>{result.index}. {result.packageId}: {result.status}</div><div className="mt-1 break-all text-muted-foreground">{result.detail}</div></div>)}</div>}
      </section>
      <section className={panelClass}>
        <SectionTitle title={locale === 'vi' ? 'Phát hành lô luyện tập đã kiểm định' : 'Release qualified Practice batch'} description={locale === 'vi' ? 'Mở các phần luyện tập đã qua kiểm định nội dung, đáp án và phương tiện. Máy chủ kiểm tra lại trước khi phát hành.' : 'Activate Practice scopes qualified for content, answer truth and media. The server checks the release gates again.'} />
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => run('corpus', async () => {
          const receipts: string[] = [];
          let count = 1;
          for (let index = 0; index < count; index++) {
            const results = await examAdminApi.releaseQualifiedCorpusPractice(index);
            if (results.length !== 1 || results[0].packageIndex !== index || !Number.isInteger(results[0].packageCount) || results[0].packageCount < 1)
              throw new Error('Invalid corpus release receipt');
            count = results[0].packageCount;
            receipts.push(`${results[0].packageId}: ${results[0].operation}${results[0].formId ? ` (${results[0].formId})` : ''}`);
            onMessage({ type: 'success', text: `${index + 1}/${count}: ${receipts.join('; ')}` });
          }
        })}>{busy === 'corpus' ? (locale === 'vi' ? 'Đang phát hành…' : 'Releasing…') : (locale === 'vi' ? 'Phát hành lô luyện tập đã kiểm định' : 'Release qualified Practice batch')}</button>
      </section>
      <section className={panelClass}>
        <SectionTitle title="EnglishCoach Original Practice" description="Import original IELTS four-skill practice, Academic and General Training Writing, three-Part Speaking, and TOEIC Listening and Reading Parts 2, 5 and 7. This records no human QA approval and publishes no official score. Existing pilot-policy and scope-readiness checks must pass." />
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => run('original', async () => {
          const results = await examAdminApi.bootstrapOriginalPractice();
          onMessage({ type: 'success', text: results.map((r) => `${r.status}: ${r.packageId} (${r.formId})`).join('; ') });
        })}>{busy === 'original' ? 'Importing original pilots…' : 'Import original practice pilots'}</button>
      </section>
      <section className={panelClass}>
        <SectionTitle title="Package JSON" description="Paste the canonical package generated by the content factory. The browser only parses it locally to identify the form; validation and import are performed by the authenticated backend." />
        <textarea value={packageText} onChange={(event) => setPackageText(event.target.value)} className={`${inputClass} min-h-64 font-mono text-xs`} placeholder={'{\n  "manifest": ...,\n  "sources": ...,\n  "form": ...\n}'} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={busy !== null || !packageText.trim()} onClick={validate}>{busy === 'validate' ? 'Validating…' : 'Validate package'}</button>
          <button type="button" className={secondaryButtonClass} disabled={busy !== null || !validation?.valid} onClick={importPackage}>{busy === 'import' ? 'Importing…' : 'Import validated package'}</button>
        </div>
        {validation && (
          <div className="mt-4 space-y-3">
            <KeyValueList values={[["Validation", validation.valid ? 'VALID' : 'INVALID'], ['Computed hash', validation.computedContentHash]]} />
            {validation.errors.length > 0 && <div className="space-y-1 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-700 dark:text-rose-300">{validation.errors.map((error, index) => <div key={`${error.path}-${index}`}><span className="font-mono">{error.path || '$'}</span> · {error.code}: {error.message}</div>)}</div>}
          </div>
        )}
        {importResult && <div className="mt-4"><KeyValueList values={[["Import status", importResult.status], ["Package", `${importResult.packageId} v${importResult.packageVersion}`], ["Form ID", importResult.formId], ["Content hash", importResult.contentHash], ["Idempotent replay", String(importResult.idempotentReplay)]]} /></div>}
      </section>

      <section className={panelClass}>
        <SectionTitle title="Imported package ledger" description="Fetch the persisted import result by package ID/version. A missing record is an actionable server response, not an empty success state." />
        <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto] sm:items-end">
          <Field label="Package ID"><input value={resolvedPackageId} onChange={(event) => setPackageId(event.target.value)} className={inputClass} placeholder="package logical ID" /></Field>
          <Field label="Version"><input type="number" min="1" value={packageVersion} onChange={(event) => setPackageVersion(event.target.value)} className={inputClass} /></Field>
          <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={loadStatus}>{busy === 'status' ? 'Loading…' : 'Load ledger status'}</button>
        </div>
        {status && <div className="mt-4"><JsonBlock value={status} /></div>}
      </section>

      <section className={panelClass}>
        <SectionTitle title="Sources and form release queue" description="These are read-only server projections. They include draft/review states without exposing answer keys or privileged media." action={<button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={loadWorkQueues}>{busy === 'queues' ? 'Loading…' : 'Refresh queues'}</button>} />
        <div className="mt-4 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Sources ({sources.length})</h3>
            {sources.length === 0 ? <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">No source rows returned for this operator.</p> : <div className="space-y-2">{sources.map((source) => <div key={source.id} className="rounded-md border border-border p-3 text-xs"><div className="font-semibold text-foreground">{source.code} · {source.name}</div><div className="mt-1 text-muted-foreground">{source.sourceType} · {source.owner || 'owner not supplied'} · {source.retiredAt ? 'retired' : 'active'}</div></div>)}</div>}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Forms ({forms.length})</h3>
            {forms.length === 0 ? <p className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">No form rows returned for this operator.</p> : <div className="space-y-2">{forms.map((form) => <button key={form.id} type="button" onClick={() => { setFormId(form.id); setReviewHash(form.contentHash); }} className="block w-full rounded-md border border-border p-3 text-left text-xs hover:bg-muted"><div className="font-semibold text-foreground">{form.title} · v{form.version}</div><div className="mt-1 text-muted-foreground">{form.id} · {form.family}/{form.variant} · {form.lifecycleState} · package {form.packageStatus || 'unknown'}</div><div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{form.contentHash}</div></button>)}</div>}
          </div>
        </div>
      </section>

      <section className={panelClass}>
        <SectionTitle title="Review and release controls" description="Each review action is attributable to the authenticated operator. Publication remains server-gated by the existing four-eye workflow." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Form ID"><input value={resolvedFormId} onChange={(event) => setFormId(event.target.value)} className={inputClass} placeholder="UUID from import or queue" /></Field>
          <Field label="Gate"><select value={gate} onChange={(event) => setGate(event.target.value)} className={inputClass}><option value="CONTENT_QA">CONTENT_QA</option><option value="ANSWER_QA">ANSWER_QA</option><option value="LEGAL_QA">LEGAL_QA</option></select></Field>
          <Field label="Decision"><select value={decision} onChange={(event) => setDecision(event.target.value)} className={inputClass}><option value="APPROVED">APPROVED</option><option value="REJECTED">REJECTED</option></select></Field>
          <Field label="Content hash"><input value={reviewHash} onChange={(event) => setReviewHash(event.target.value)} className={inputClass} placeholder="must match imported form" /></Field>
        </div>
        <Field label="Notes"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} className={`${inputClass} min-h-20`} placeholder="Evidence or rejection reason" /></Field>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={submitReview}>{busy === 'review' ? 'Submitting…' : 'Submit review decision'}</button>
          <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => release('publish')}>{busy === 'publish' ? 'Publishing…' : 'Publish form'}</button>
          <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => release('retire')}>{busy === 'retire' ? 'Retiring…' : 'Retire form'}</button>
        </div>
      </section>
    </div>
  );
}
