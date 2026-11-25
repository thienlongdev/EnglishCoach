'use client';

import React, { useState } from 'react';
import type { AdminMessage } from './ExamAdminConsole';
import { examAdminApi, getApiErrorMessage } from '@/services/examAdminApi';
import type { CalibrationPackage } from '@/types/exam-admin';
import { buttonClass, Field, inputClass, JsonBlock, KeyValueList, panelClass, secondaryButtonClass, SectionTitle } from './ExamAdminPrimitives';

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

export function ExamAdminCalibrationPanel({ onMessage }: { onMessage: (message: AdminMessage) => void }) {
  const [packageId, setPackageId] = useState('');
  const [logicalCode, setLogicalCode] = useState('');
  const [version, setVersion] = useState('1');
  const [formId, setFormId] = useState('');
  const [scoringSchemeId, setScoringSchemeId] = useState('');
  const [measurementRunId, setMeasurementRunId] = useState('');
  const [method, setMethod] = useState('EVIDENCE_BACKED_MONOTONIC_MAPPING');
  const [maturityStage, setMaturityStage] = useState('PILOT');
  const [mappingTable, setMappingTable] = useState('{\n  "ranges": [\n    {"min": 0, "max": 1, "scaled": 1}\n  ]\n}');
  const [uncertaintyModel, setUncertaintyModel] = useState('{\n  "method": "bootstrap",\n  "confidence": 0.95\n}');
  const [evidenceHash, setEvidenceHash] = useState('');
  const [validationReport, setValidationReport] = useState('');
  const [calibration, setCalibration] = useState<CalibrationPackage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try { await action(); } catch (error) { onMessage({ type: 'error', text: getApiErrorMessage(error) }); }
    finally { setBusy(null); }
  };

  const create = () => runAction('create', async () => {
    if (!/^[0-9a-fA-F]{64}$/.test(evidenceHash)) throw new Error('Evidence hash must be exactly 64 hexadecimal characters');
    const result = await examAdminApi.createCalibration({ logicalCode, version: Number(version), formId, scoringSchemeId, measurementRunId, method, maturityStage, mappingTable: parseObject(mappingTable, 'Mapping table'), uncertaintyModel: parseObject(uncertaintyModel, 'Uncertainty model'), evidenceHash, validationReport });
    setPackageId(result.packageId);
    onMessage({ type: 'success', text: `Created immutable calibration package ${result.packageId}; approval state is ${result.approvalState}.` });
  });

  const load = () => runAction('load', async () => {
    if (!packageId.trim()) throw new Error('Enter a calibration package UUID');
    const result = await examAdminApi.getCalibration(packageId.trim());
    setCalibration(result);
    setFormId(result.formId);
    setScoringSchemeId(result.scoringSchemeId);
    setMeasurementRunId(result.measurementRunId);
    onMessage({ type: 'success', text: `Loaded calibration package ${result.id}: ${result.approvalState}.` });
  });

  const approve = () => runAction('approve', async () => {
    if (!packageId.trim()) throw new Error('Enter a calibration package UUID');
    const result = await examAdminApi.approveCalibration(packageId.trim());
    onMessage({ type: 'success', text: `Calibration package ${result.packageId} is ${result.approvalState}.` });
    const refreshed = await examAdminApi.getCalibration(packageId.trim());
    setCalibration(refreshed);
  });

  return (
    <div className="space-y-5">
      <section className={panelClass}>
        <SectionTitle title="Immutable calibration package" description="A package preserves the existing form scoring-scheme reference and a final measurement run. The backend rejects arbitrary, non-monotonic, empty, or unproven mappings." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4"><Field label="Package ID"><input value={packageId} onChange={(event) => setPackageId(event.target.value)} className={inputClass} placeholder="returned UUID" /></Field><Field label="Logical code"><input value={logicalCode} onChange={(event) => setLogicalCode(event.target.value)} className={inputClass} placeholder="ielts-writing-band" /></Field><Field label="Version"><input type="number" min="1" value={version} onChange={(event) => setVersion(event.target.value)} className={inputClass} /></Field><Field label="Maturity stage"><input value={maturityStage} onChange={(event) => setMaturityStage(event.target.value)} className={inputClass} /></Field><Field label="Form ID"><input value={formId} onChange={(event) => setFormId(event.target.value)} className={inputClass} placeholder="imported form UUID" /></Field><Field label="Existing scoring scheme ID"><input value={scoringSchemeId} onChange={(event) => setScoringSchemeId(event.target.value)} className={inputClass} placeholder="server-owned UUID" /></Field><Field label="Final measurement run ID"><input value={measurementRunId} onChange={(event) => setMeasurementRunId(event.target.value)} className={inputClass} placeholder="FINAL run UUID" /></Field><Field label="Method"><input value={method} onChange={(event) => setMethod(event.target.value)} className={inputClass} /></Field></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2"><Field label="Mapping table JSON"><textarea value={mappingTable} onChange={(event) => setMappingTable(event.target.value)} className={`${inputClass} min-h-36 font-mono text-xs`} /></Field><Field label="Uncertainty model JSON"><textarea value={uncertaintyModel} onChange={(event) => setUncertaintyModel(event.target.value)} className={`${inputClass} min-h-36 font-mono text-xs`} /></Field></div>
        <div className="mt-3 grid gap-3 md:grid-cols-2"><Field label="Evidence hash" hint="64 hex characters"><input value={evidenceHash} onChange={(event) => setEvidenceHash(event.target.value)} className={`${inputClass} font-mono`} placeholder="sha256..." /></Field><Field label="Validation report"><textarea value={validationReport} onChange={(event) => setValidationReport(event.target.value)} className={`${inputClass} min-h-20`} placeholder="linked report and evidence references" /></Field></div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy !== null} onClick={create}>{busy === 'create' ? 'Creating…' : 'Create pending package'}</button><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={load}>{busy === 'load' ? 'Loading…' : 'Load package'}</button><button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={approve}>{busy === 'approve' ? 'Approving…' : 'Approve package'}</button></div>
      </section>

      {calibration && <section className={panelClass}><SectionTitle title="Server calibration record" description="Approval evidence and actor attribution are returned by the backend. This view does not rewrite the runtime scoring scheme." /><KeyValueList values={[["ID", calibration.id], ["Logical code", `${calibration.logicalCode} v${calibration.version}`], ["Approval", calibration.approvalState], ["Form", calibration.formId], ["Scoring scheme", calibration.scoringSchemeId], ["Measurement run", calibration.measurementRunId], ["Approved by", calibration.approvedBy], ["Approved at", calibration.approvedAt]]} /><div className="mt-4 grid gap-3 md:grid-cols-2"><div><h3 className="mb-1 text-xs font-bold text-foreground">Mapping</h3><JsonBlock value={calibration.mappingTable} /></div><div><h3 className="mb-1 text-xs font-bold text-foreground">Uncertainty</h3><JsonBlock value={calibration.uncertaintyModel} /></div></div></section>}
    </div>
  );
}

