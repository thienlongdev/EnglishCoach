'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { WritingSession, PlanOrganizationResult, SocraticPlanResponse, SocraticSuggestionItem } from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { getCategoryLabel } from '@/lib/writing/labels';
import { TaskVisualChart } from './TaskVisualChart';
import { echoSrc } from '@/lib/brand/echoCharacters';

export interface StructuredPlan {
  thesis: string;
  propA: string; // Concession / Counter-Argument
  propB: string; // Core Refutation / Main Reason
  propC: string; // Synthesis / Practical Solution
  counterargument?: string;
  rebuttal?: string;
  evidence?: string;
  notes?: string;
  rawText?: string;
  version?: number;
}

export function parsePlanToState(raw: string): StructuredPlan {
  if (!raw || !raw.trim()) {
    return {
      thesis: '',
      propA: '',
      propB: '',
      propC: '',
      counterargument: '',
      rebuttal: '',
      evidence: '',
      notes: '',
      rawText: '',
      version: 1
    };
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        thesis: obj.thesis || '',
        propA: obj.propA || obj.counterargument || '',
        propB: obj.propB || (Array.isArray(obj.bodyArguments) ? obj.bodyArguments.join('\n') : (obj.bodyArguments || '')),
        propC: obj.propC || obj.conclusion || '',
        counterargument: obj.counterargument || obj.propA || '',
        rebuttal: obj.rebuttal || '',
        evidence: Array.isArray(obj.evidence) ? obj.evidence.join('\n') : (obj.evidence || ''),
        notes: obj.notes || '',
        rawText: obj.rawText || '',
        version: obj.version || 1
      };
    } catch (e) {
      // ignore, fall through to text parsing
    }
  }

  // Text parsing
  let thesis = '';
  let propA = '';
  let propB = '';
  let propC = '';
  let notes = '';

  const sections = trimmed.split(/\[([^\]]+)\]/);
  if (sections.length > 1) {
    for (let i = 1; i < sections.length; i += 2) {
      const header = sections[i].toLowerCase();
      const body = (sections[i + 1] || '').trim().replace(/^•\s*/gm, '').trim();
      if (header.includes('thesis') || header.includes('stance') || header.includes('luận điểm chính') || header.includes('lập trường')) {
        thesis = body;
      } else if (header.includes('proposition a') || header.includes('concession') || header.includes('counter') || header.includes('nhượng bộ') || header.includes('phản biện')) {
        propA = body;
      } else if (header.includes('proposition b') || header.includes('refutation') || header.includes('main reason') || header.includes('bác bỏ') || header.includes('lập trường cốt lõi')) {
        propB = body;
      } else if (header.includes('proposition c') || header.includes('synthesis') || header.includes('solution') || header.includes('conclusion') || header.includes('đúc kết') || header.includes('giải pháp')) {
        propC = body;
      } else if (header.includes('note') || header.includes('ghi chú') || header.includes('dẫn chứng')) {
        notes = body;
      }
    }
  } else {
    // Plain text / single input (e.g. "hello guy") -> preserve in notes, thesis, and rawText
    thesis = trimmed;
    notes = trimmed;
  }

  return {
    thesis,
    propA,
    propB,
    propC,
    counterargument: propA,
    rebuttal: '',
    evidence: '',
    notes,
    rawText: trimmed,
    version: 1
  };
}

export function serializeStructuredPlan(plan: StructuredPlan): string {
  const parts: string[] = [];
  if (plan.thesis?.trim()) parts.push(`[Luận điểm chính / Lập trường]\n• ${plan.thesis.trim()}`);
  if (plan.propA?.trim()) parts.push(`[Luận cứ A: Nhượng bộ và Phản biện]\n• ${plan.propA.trim()}`);
  if (plan.propB?.trim()) parts.push(`[Luận cứ B: Khẳng định lập trường cốt lõi]\n• ${plan.propB.trim()}`);
  if (plan.propC?.trim()) parts.push(`[Luận cứ C: Đúc kết và Giải pháp thực tiễn]\n• ${plan.propC.trim()}`);
  if (plan.notes?.trim()) parts.push(`[Ghi chú cá nhân]\n• ${plan.notes.trim()}`);

  const readableText = parts.join('\n\n');

  const payload = {
    thesis: (plan.thesis || '').trim(),
    propA: (plan.propA || '').trim(),
    propB: (plan.propB || '').trim(),
    propC: (plan.propC || '').trim(),
    bodyArguments: plan.propB?.trim() ? [plan.propB.trim()] : [],
    counterargument: (plan.propA || '').trim(),
    rebuttal: (plan.rebuttal || '').trim(),
    evidence: plan.evidence?.trim() ? [plan.evidence.trim()] : [],
    conclusion: (plan.propC || '').trim(),
    notes: (plan.notes || '').trim(),
    rawText: plan.rawText || readableText || '',
    version: 1
  };

  return JSON.stringify(payload);
}

import { glass } from '../glass/WritingGlass';
interface PlanningFormProps {
  session: WritingSession;
  onBackToTask: () => void;
  onProceedToDrafting: (planOrSession: string | WritingSession) => void;
  onSessionUpdated?: (updatedSession: WritingSession) => void;
}

export const PlanningForm: React.FC<PlanningFormProps> = ({
  session,
  onBackToTask,
  onProceedToDrafting,
  onSessionUpdated
}) => {
  // Parse initial working plan from database with zero loss
  const initial = useMemo(() => parsePlanToState(session.workingPlan || ''), []);

  const [thesisText, setThesisText] = useState<string>(initial.thesis);
  const [propA, setPropA] = useState<string>(initial.propA);
  const [propB, setPropB] = useState<string>(initial.propB);
  const [propC, setPropC] = useState<string>(initial.propC);
  const [notesText, setNotesText] = useState<string>(initial.notes || '');
  const [planText, setPlanText] = useState<string>(initial.rawText || session.workingPlan || '');

  const [saveStatus, setSaveStatus] = useState<'UNSAVED' | 'SAVING' | 'SAVED' | 'SAVE_FAILED'>('SAVED');
  const [advancing, setAdvancing] = useState<boolean>(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  // Socratic Planning Coach state
  const [socraticResult, setSocraticResult] = useState<SocraticPlanResponse | null>(null);
  const [loadingSocratic, setLoadingSocratic] = useState<boolean>(false);
  const [socraticQuestion, setSocraticQuestion] = useState<string>('');
  const [showSocratic, setShowSocratic] = useState<boolean>(false);
  const [isAdvisorCollapsed, setIsAdvisorCollapsed] = useState<boolean>(false);
  const [addedSuggestionIds, setAddedSuggestionIds] = useState<Set<string>>(new Set());
  const [newSuggestionIds, setNewSuggestionIds] = useState<Set<string>>(new Set());
  const [socraticToast, setSocraticToast] = useState<string | null>(null);

  // AI Organizer state
  const [organizing, setOrganizing] = useState<boolean>(false);
  const [organizedResult, setOrganizedResult] = useState<PlanOrganizationResult | null>(null);
  const [socraticError, setSocraticError] = useState<string | null>(null);
  const [organizeError, setOrganizeError] = useState<string | null>(null);

  // Track revision in ref
  const revisionRef = useRef<number>(session.currentRevision);
  useEffect(() => {
    revisionRef.current = session.currentRevision;
  }, [session.currentRevision]);

  // Sync structured inputs to master planText & build payload
  const buildCurrentStructuredPlan = (
    th = thesisText,
    pa = propA,
    pb = propB,
    pc = propC,
    nt = notesText,
    pt = planText
  ): StructuredPlan => {
    const parts: string[] = [];
    if (th.trim()) parts.push(`[Thesis / Stance]\n• ${th.trim()}`);
    if (pa.trim()) parts.push(`[Proposition A: Concession / Counter-Argument]\n• ${pa.trim()}`);
    if (pb.trim()) parts.push(`[Proposition B: Core Refutation / Main Reason]\n• ${pb.trim()}`);
    if (pc.trim()) parts.push(`[Proposition C: Synthesis / Practical Solution]\n• ${pc.trim()}`);
    if (nt.trim()) parts.push(`[Notes / Ghi chú]\n• ${nt.trim()}`);

    let readable = parts.join('\n\n');
    let effectiveNotes = nt;
    let effectiveThesis = th;

    if (!readable.trim() && pt.trim()) {
      readable = pt.trim();
      if (!effectiveNotes.trim()) effectiveNotes = pt.trim();
      if (!effectiveThesis.trim()) effectiveThesis = pt.trim();
    } else if (pt.trim() && readable.trim() && !readable.includes(pt.trim()) && !pt.includes(readable)) {
      readable = `${readable}\n\n[Custom Notes / Dàn ý bổ sung]\n• ${pt.trim()}`;
    }

    return {
      thesis: effectiveThesis,
      propA: pa,
      propB: pb,
      propC: pc,
      counterargument: pa,
      notes: effectiveNotes,
      rawText: pt.trim() || readable
    };
  };

  const handleThesisChange = (val: string) => {
    setThesisText(val);
    if (socraticError) setSocraticError(null);
    setSaveStatus('UNSAVED');
    const p = buildCurrentStructuredPlan(val, propA, propB, propC, notesText);
    setPlanText(p.rawText || '');
  };

  const handlePropAChange = (val: string) => {
    setPropA(val);
    if (socraticError) setSocraticError(null);
    setSaveStatus('UNSAVED');
    const p = buildCurrentStructuredPlan(thesisText, val, propB, propC, notesText);
    setPlanText(p.rawText || '');
  };

  const handlePropBChange = (val: string) => {
    setPropB(val);
    if (socraticError) setSocraticError(null);
    setSaveStatus('UNSAVED');
    const p = buildCurrentStructuredPlan(thesisText, propA, val, propC, notesText);
    setPlanText(p.rawText || '');
  };

  const handlePropCChange = (val: string) => {
    setPropC(val);
    if (socraticError) setSocraticError(null);
    setSaveStatus('UNSAVED');
    const p = buildCurrentStructuredPlan(thesisText, propA, propB, val, notesText);
    setPlanText(p.rawText || '');
  };

  const handleNotesChange = (val: string) => {
    setNotesText(val);
    if (socraticError) setSocraticError(null);
    setSaveStatus('UNSAVED');
    const p = buildCurrentStructuredPlan(thesisText, propA, propB, propC, val);
    setPlanText(p.rawText || '');
  };

  const handlePlanTextDirectChange = (val: string) => {
    setPlanText(val);
    if (socraticError) setSocraticError(null);
    setSaveStatus('UNSAVED');
  };

  // Explicit Save Outline handler with full database confirmation
  const handleSaveWorkingCopy = async () => {
    if (saveStatus === 'SAVING') return;
    setSaveStatus('SAVING');
    setTransitionError(null);

    const currentPlan = buildCurrentStructuredPlan();
    const serialized = serializeStructuredPlan(currentPlan);

    try {
      const updated = await writingApi.updateWorkingCopy(
        session.id,
        session.workingText || '',
        serialized,
        revisionRef.current
      );

      revisionRef.current = updated.currentRevision;
      if (onSessionUpdated) {
        onSessionUpdated(updated);
      }
      setSaveStatus('SAVED');
    } catch (err: any) {
      console.error('Failed to save plan copy', err);
      // Attempt 409 reconciliation
      if (err?.response?.status === 409 || err?.status === 409) {
        try {
          const fresh = await writingApi.getSession(session.id);
          revisionRef.current = fresh.currentRevision;
          const reconciled = await writingApi.updateWorkingCopy(
            session.id,
            fresh.workingText || '',
            serialized,
            fresh.currentRevision
          );
          revisionRef.current = reconciled.currentRevision;
          if (onSessionUpdated) {
            onSessionUpdated(reconciled);
          }
          setSaveStatus('SAVED');
          return;
        } catch (rErr) {
          console.error('Reconciliation failed', rErr);
        }
      }
      setSaveStatus('SAVE_FAILED');
    }
  };

  // AI Organizer
  const handleOrganize = async () => {
    if (!planText.trim()) return;
    setOrganizing(true);
    setOrganizeError(null);
    try {
      const currentPlan = buildCurrentStructuredPlan();
      const serialized = serializeStructuredPlan(currentPlan);
      const updated = await writingApi.updateWorkingCopy(
        session.id,
        session.workingText || '',
        serialized,
        revisionRef.current
      );
      revisionRef.current = updated.currentRevision;
      if (onSessionUpdated) onSessionUpdated(updated);

      const result = await writingApi.organizePlan(session.id);
      
      // Directly populate the ONE real editable outline from result (no duplicate preview)
      const formatted = result.organized_sections
        .map(
          (sec) =>
            `[${sec.section_title}]\n` +
            sec.points.map((pt) => `• ${cleanPointText(pt)}`).filter((p) => p.length > 2).join('\n')
        )
        .join('\n\n');

      setPlanText(formatted);

      // Sync structured fields from sections
      const introSec = result.organized_sections.find((s) => /intro|mở bài|thesis/i.test(s.section_title));
      let nextTh = thesisText;
      if (introSec && introSec.points.length > 0) {
        nextTh = introSec.points.map(cleanPointText).join('. ');
        setThesisText(nextTh);
      }
      const bodySecs = result.organized_sections.filter((s) => /body|thân bài|overview|luận điểm|detail/i.test(s.section_title));
      let nextA = propA;
      let nextB = propB;
      let nextC = propC;
      if (bodySecs.length > 0 && bodySecs[0].points.length > 0) {
        nextA = bodySecs[0].points.map(cleanPointText).join('. ');
        setPropA(nextA);
      }
      if (bodySecs.length > 1 && bodySecs[1].points.length > 0) {
        nextB = bodySecs[1].points.map(cleanPointText).join('. ');
        setPropB(nextB);
      }
      if (bodySecs.length > 2 && bodySecs[2].points.length > 0) {
        nextC = bodySecs[2].points.map(cleanPointText).join('. ');
        setPropC(nextC);
      }
      const concSec = result.organized_sections.find((s) => /conclu|kết bài|action/i.test(s.section_title));
      let nextNotes = notesText;
      if (concSec && concSec.points.length > 0) {
        nextNotes = concSec.points.map(cleanPointText).join('. ');
        setNotesText(nextNotes);
      }

      setOrganizedResult(null);

      // Save updated plan to working copy
      const nextPlan = buildCurrentStructuredPlan(nextTh, nextA, nextB, nextC, nextNotes, formatted);
      const serializedNext = serializeStructuredPlan(nextPlan);
      const saved = await writingApi.updateWorkingCopy(
        session.id,
        session.workingText || '',
        serializedNext,
        revisionRef.current
      );
      revisionRef.current = saved.currentRevision;
      if (onSessionUpdated) onSessionUpdated(saved);
      setSaveStatus('SAVED');
      setSocraticToast('AI đã sắp xếp ý tưởng trực tiếp vào dàn ý của bạn.');
    } catch (err) {
      console.error('Failed to organize plan', err);
      setOrganizeError('Không thể sắp xếp dàn ý cùng AI vào lúc này. Vui lòng thử lại.');
    } finally {
      setOrganizing(false);
    }
  };

  // Helper to clean point text from AI
  const cleanPointText = (text: string): string => {
    if (!text) return '';
    let cleaned = text.trim();
    if (cleaned.startsWith('{') && cleaned.endsWith('}')) {
      try {
        const obj = JSON.parse(cleaned);
        const vals = Object.values(obj).filter(Boolean);
        if (vals.length > 0) return vals.join('; ');
      } catch (e) {
        cleaned = cleaned.replace(/^\{+/, '').replace(/\}+$/, '');
      }
    }
    cleaned = cleaned.replace(/^"?[a-zA-Z0-9_-]+"?\s*:\s*"?/, '');
    cleaned = cleaned.replace(/"?\s*\}*$/, '');
    cleaned = cleaned.replace(/\\n/g, ' ').replace(/\\"/g, '"');
    cleaned = cleaned.replace(/^[•\-\*\s]+/, '').trim();
    return cleaned;
  };

  // Derived real outline membership check for advisor suggestions
  const isSuggestionInOutline = (itemContent: string): boolean => {
    if (!itemContent || !itemContent.trim()) return false;
    const target = itemContent.trim().toLowerCase();
    const allOutlineText = [thesisText, propA, propB, propC, notesText, planText].join('\n').toLowerCase();
    return allOutlineText.includes(target);
  };

  // Socratic Advisor with intent classification & visible suggested items
  const handleGetSocraticGuidance = async (forceFresh = false) => {
    if (loadingSocratic) return;
    setLoadingSocratic(true);
    setSocraticToast(null);
    setSocraticError(null);
    try {
      const currentPlan = buildCurrentStructuredPlan();
      const userInstruction = socraticQuestion.trim();

      let promptText = session.taskSnapshot?.prompt || session.taskSnapshot?.title || 'Writing Task';
      if (session.taskSnapshot?.title && session.taskSnapshot?.prompt && !session.taskSnapshot.prompt.includes(session.taskSnapshot.title)) {
        promptText = `${session.taskSnapshot.title}: ${session.taskSnapshot.prompt}`;
      }
      if (session.taskSnapshot?.visualData) {
        try {
          const visualStr = typeof session.taskSnapshot.visualData === 'string'
            ? session.taskSnapshot.visualData
            : JSON.stringify(session.taskSnapshot.visualData);
          promptText += `\n[Chart/Visual Data]: ${visualStr}`;
        } catch {
          // ignore
        }
      }

      const effectivePlan = (currentPlan.rawText || planText || '').trim();

      const res = await writingApi.getSocraticGuidance({
        taskPrompt: promptText,
        currentPlan: effectivePlan,
        learnerQuestion: userInstruction || undefined
      });

      if (res.suggested_items && res.suggested_items.length > 0) {
        const newIds = new Set(res.suggested_items.map((it) => it.id));
        setNewSuggestionIds(newIds);
        setSocraticToast(`Cố vấn tư duy đã gợi ý ${res.suggested_items.length} luận điểm mới cho dàn ý của bạn.`);
      }

      setSocraticResult(res);
      setShowSocratic(true);
      setIsAdvisorCollapsed(false);
      setSocraticQuestion('');
      setTimeout(() => {
        document.getElementById('socratic-advisor-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    } catch (err) {
      console.error('Failed to fetch Socratic planning guidance', err);
      setSocraticError('Không thể kết nối Cố vấn tư duy vào lúc này. Vui lòng thử lại.');
    } finally {
      setLoadingSocratic(false);
    }
  };

  const handleAdvisorClick = async () => {
    if (loadingSocratic) return;

    const currentPlan = buildCurrentStructuredPlan();
    const effectivePlan = (currentPlan.rawText || planText || '').trim();

    if (!effectivePlan) {
      setSocraticError('Hãy nhập ít nhất một ý tưởng (luận điểm, phản biện hoặc ghi chú) trước khi xin cố vấn tư duy.');
      const thesisInput = document.getElementById('thesis-input');
      if (thesisInput) {
        thesisInput.focus();
        thesisInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    setSocraticError(null);

    // If socratic result already exists and panel is collapsed, uncollapse and scroll into view
    if (socraticResult && isAdvisorCollapsed) {
      setIsAdvisorCollapsed(false);
      setShowSocratic(true);
      setTimeout(() => {
        document.getElementById('socratic-advisor-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      return;
    }

    await handleGetSocraticGuidance();
  };

  const handleOpenAdvisor = handleAdvisorClick;

  // Accept and apply AI suggestion directly to canonical plan state
  const handleApplySuggestion = (item: SocraticSuggestionItem) => {
    let nextA = propA;
    let nextB = propB;
    let nextC = propC;
    let nextTh = thesisText;
    let targetSectionName = planLabels.propBLabel;

    if (item.section === 'counterargument' || item.operation === 'COUNTERARGUMENT') {
      nextA = nextA ? `${nextA}\n• ${item.content}` : item.content;
      setPropA(nextA);
      targetSectionName = planLabels.propALabel;
    } else if (item.section === 'main_argument') {
      nextB = nextB ? `${nextB}\n• ${item.content}` : item.content;
      setPropB(nextB);
      targetSectionName = planLabels.propBLabel;
    } else if (item.section === 'synthesis' || item.section === 'conclusion') {
      nextC = nextC ? `${nextC}\n• ${item.content}` : item.content;
      setPropC(nextC);
      targetSectionName = planLabels.propCLabel;
    } else if (item.section === 'thesis') {
      nextTh = nextTh ? `${nextTh} • ${item.content}` : item.content;
      setThesisText(nextTh);
      targetSectionName = planLabels.thesisLabel;
    } else {
      nextB = nextB ? `${nextB}\n• ${item.content}` : item.content;
      setPropB(nextB);
      targetSectionName = planLabels.propBLabel;
    }

    const updated = buildCurrentStructuredPlan(nextTh, nextA, nextB, nextC, notesText);
    setPlanText(updated.rawText || '');
    setSaveStatus('UNSAVED');
    setAddedSuggestionIds((prev) => new Set([...Array.from(prev), item.id]));
    setSocraticToast(`Đã thêm vào ${targetSectionName}: "${item.content.length > 50 ? item.content.slice(0, 48) + '...' : item.content}"`);
  };

  const handleAppendToPlan = (textToAppend: string) => {
    setPlanText((prev) => (prev ? `${prev}\n• ${textToAppend}` : `• ${textToAppend}`));
    setSaveStatus('UNSAVED');
  };

  // Safe Stage Transition Ordering (Flush -> Await Save -> Advance Stage)
  const handleProceedToDrafting = async () => {
    if (advancing) return;
    setAdvancing(true);
    setTransitionError(null);

    try {
      const currentPlan = buildCurrentStructuredPlan();
      const serialized = serializeStructuredPlan(currentPlan);

      // 1. Flush pending plan edits to guarantee persistence
      let freshRev = revisionRef.current;
      try {
        const savedSession = await writingApi.updateWorkingCopy(
          session.id,
          session.workingText || '',
          serialized,
          freshRev
        );
        freshRev = savedSession.currentRevision;
        revisionRef.current = freshRev;
        if (onSessionUpdated) onSessionUpdated(savedSession);
      } catch (saveErr: any) {
        if (saveErr?.response?.status === 409 || saveErr?.status === 409) {
          const fresh = await writingApi.getSession(session.id);
          const reconciled = await writingApi.updateWorkingCopy(
            session.id,
            fresh.workingText || '',
            serialized,
            fresh.currentRevision
          );
          freshRev = reconciled.currentRevision;
          revisionRef.current = freshRev;
          if (onSessionUpdated) onSessionUpdated(reconciled);
        } else {
          throw saveErr;
        }
      }

      // 2. Advance stage to DRAFTING using the exact verified revision
      const advanced = await writingApi.advanceStage(session.id, 'DRAFTING', freshRev);
      revisionRef.current = advanced.currentRevision;
      if (onSessionUpdated) onSessionUpdated(advanced);
      onProceedToDrafting(advanced);
    } catch (err: any) {
      console.error('Failed to advance stage to DRAFTING', err);
      setTransitionError(err?.message || 'Không thể chuyển sang viết nháp. Vui lòng thử lại.');
    } finally {
      setAdvancing(false);
    }
  };

  const hasContent = Boolean(
    thesisText.trim() || propA.trim() || propB.trim() || propC.trim() || notesText.trim() || planText.trim()
  );

  const task = session.taskSnapshot || {};

  const isTask1 = useMemo(() => {
    const sub = String(task.taskSubtype || session.taskSnapshot?.taskSubtype || '').toLowerCase();
    const id = String(task.id || session.taskSnapshot?.id || '').toLowerCase();
    const fam = String(task.family || session.taskSnapshot?.family || '').toUpperCase();
    return id.startsWith('ielts-t1-') || (fam === 'IELTS' && ['line_chart', 'bar_chart', 'pie_chart', 'table', 'process', 'map', 'mixed_data'].includes(sub));
  }, [task, session]);

  const isTask2 = useMemo(() => {
    const id = String(task.id || session.taskSnapshot?.id || '').toLowerCase();
    const fam = String(task.family || session.taskSnapshot?.family || '').toUpperCase();
    return id.startsWith('ielts-t2-') || (fam === 'IELTS' && !isTask1);
  }, [task, session, isTask1]);

  const planLabels = useMemo(() => {
    if (isTask1) {
      const visual = task.visualData || session.taskSnapshot?.visualData;
      const vTitle = visual?.title || task.title || 'the visual representation';
      const cType = visual?.chartType || 'diagram';
      const typeName = cType === 'bar' ? 'bar chart' : cType === 'pie' ? 'pie chart' : cType === 'table' ? 'table' : cType === 'process' ? 'process diagram' : cType === 'map' ? 'map' : 'graph';
      const seriesNames = visual?.series?.map((s: any) => s.name).join(', ') || visual?.categories?.slice(0, 2).join(' and ') || 'the key categories';
      const firstYear = visual?.xAxis?.categories?.[0] || 'the initial period';
      const lastYear = visual?.xAxis?.categories?.[visual?.xAxis?.categories?.length - 1] || 'the final period';

      return {
        sectionTitle: 'Xây dựng cấu trúc bài báo cáo số liệu IELTS Task 1',
        guideTitle: 'Cấu trúc báo cáo học thuật IELTS Task 1',
        guideText: 'Báo cáo Task 1 cần trình bày khách quan: Giới thiệu (Introduction), Tổng quan xu hướng chính (Overview), và 2 đoạn mô tả số liệu cụ thể (Details). Tuyệt đối không đưa ý kiến cá nhân.',
        thesisLabel: 'Mở bài và Diễn giải đề bài (Introduction and Paraphrase)',
        thesisBadge: 'Mở bài (1-2 câu)',
        thesisDesc: 'Diễn đạt lại đề bài bằng từ vựng và cấu trúc ngữ pháp của riêng bạn.',
        thesisPlaceholder: `The provided ${typeName} illustrates data regarding ${vTitle.toLowerCase()}...`,
        propALabel: 'Đoạn 1 • Tổng quan xu hướng nổi bật (Overview)',
        propABadge: 'Tổng quan (Overview)',
        propADesc: 'Nêu 2-3 đặc điểm/xu hướng nổi bật nhất của biểu đồ mà không đưa số liệu cụ thể.',
        propAPlaceholder: `Overall, it is noticeable that the primary trends across ${seriesNames}...`,
        propAHoursHint: 'Cụm liên kết: [Overall, it is noticeable that... / In general, ...]',
        propBLabel: 'Đoạn 2 • Phân tích chi tiết nhóm số liệu 1 (Detail Paragraph 1)',
        propBBadge: 'Thân bài 1 (Số liệu so sánh)',
        propBDesc: 'Nhóm các số liệu đầu tiên hoặc xu hướng cao nhất và so sánh số liệu cụ thể.',
        propBPlaceholder: `Looking at the figures in more detail, in ${firstYear}, the highest figure was recorded for...`,
        propBHoursHint: 'Từ vựng số liệu: [stood at / accounted for / reached a peak of / rose dramatically to]',
        propCLabel: 'Đoạn 3 • Phân tích chi tiết nhóm số liệu 2 (Detail Paragraph 2)',
        propCBadge: 'Thân bài 2 (Số liệu tương phản)',
        propCDesc: 'So sánh các nhóm số liệu còn lại hoặc xu hướng tương phản để hoàn thiện bài viết.',
        propCPlaceholder: `In contrast, by ${lastYear}, the remaining figures experienced...`,
        propCHoursHint: 'Liên từ đối lập: [In stark contrast / Meanwhile / Conversely / On the other hand]'
      };
    }

    if (isTask2) {
      return {
        sectionTitle: 'Xây dựng cấu trúc bài luận học thuật IELTS Task 2',
        guideTitle: 'Cấu trúc lập luận biện chứng IELTS Task 2',
        guideText: 'Người viết học thuật xuất sắc nâng cao tính thuyết phục bằng cách thừa nhận phản biện trước khi khẳng định lập trường cốt lõi và dẫn chứng minh họa.',
        thesisLabel: 'Luận điểm chính và Lập trường cốt lõi (Thesis Statement and Stance)',
        thesisBadge: 'Mở bài và Định hướng',
        thesisDesc: 'Quan điểm dứt khoát của bạn là gì? Hãy nêu rõ mức độ đồng ý/không đồng ý trong câu mở bài.',
        thesisPlaceholder: 'State your definitive thesis statement and extent of agreement/disagreement...',
        propALabel: 'Khối A • Nhượng bộ và Xem xét phản biện (Concession / Counterargument)',
        propABadge: 'Thân bài đoạn 1',
        propADesc: 'Quan điểm đối lập có lý lẽ xác đáng nào? (ví dụ: While proponents argue that...)',
        propAPlaceholder: 'While proponents argue that higher education brings private returns to graduates...',
        propAHoursHint: 'Liên từ nhượng bộ: [While / Admittedly / It is undeniable that / Although]',
        propBLabel: 'Khối B • Khẳng định lập trường chính và Dẫn chứng (Main Arguments and Evidence)',
        propBBadge: 'Thân bài đoạn 2',
        propBDesc: 'Tại sao lập trường chính của bạn thuyết phục hơn? Cung cấp lý lẽ và bằng chứng cụ thể.',
        propBPlaceholder: 'However, societal advancement depends heavily on equitable access for all qualified minds...',
        propBHoursHint: 'Liên từ tăng tiến: [Consequently / More importantly / In addition / For example]',
        propCLabel: 'Khối C • Đúc kết và Kết luận (Conclusion and Synthesis)',
        propCBadge: 'Kết luận',
        propCDesc: 'Tóm lược luận điểm và khẳng định lại quan điểm cuối cùng.',
        propCPlaceholder: 'In conclusion, while funding challenges exist, public investment in university education is indispensable...',
        propCHoursHint: 'Cụm kết bài: [In conclusion / To summarize / Ultimately]'
      };
    }

    return {
      sectionTitle: 'Xây dựng cấu trúc bài viết',
      guideTitle: 'Cấu trúc bài viết mạch lạc',
      guideText: 'Tổ chức bài viết rõ ràng theo từng phần giúp người đọc nắm bắt thông điệp nhanh chóng và chính xác.',
      thesisLabel: 'Mục đích bài viết và Lời mở đầu (Purpose and Opening)',
      thesisBadge: 'Mở đầu',
      thesisDesc: 'Nêu rõ lý do viết bài và thông điệp trọng tâm gửi đến người nhận.',
      thesisPlaceholder: 'I am writing to express my appreciation for...',
      propALabel: 'Nội dung chính 1 (Key Point 1)',
      propABadge: 'Thân bài 1',
      propADesc: 'Trình bày chi tiết hoặc yêu cầu đầu tiên một cách rõ ràng.',
      propAPlaceholder: 'Firstly, regarding the project deadline...',
      propAHoursHint: 'Liên từ: [First and foremost / In the first place / Regarding]',
      propBLabel: 'Nội dung chính 2 (Key Point 2)',
      propBBadge: 'Thân bài 2',
      propBDesc: 'Bổ sung thông tin chi tiết, đề xuất giải pháp hoặc câu hỏi làm rõ.',
      propBPlaceholder: 'Furthermore, it would be beneficial to...',
      propBHoursHint: 'Liên từ: [Furthermore / In addition / Additionally]',
      propCLabel: 'Hành động mong đợi và Lời kết (Action Request and Closing)',
      propCBadge: 'Lời kết',
      propCDesc: 'Nêu hành động tiếp theo bạn kỳ vọng từ người nhận và lời chào trang trọng.',
      propCPlaceholder: 'I look forward to your prompt response. Yours sincerely,...',
      propCHoursHint: 'Cụm kết thúc: [I look forward to hearing from you / Best regards]'
    };
  }, [isTask1, isTask2]);

  return (
    <div className="w-full max-w-max-content-width mx-auto flex flex-col gap-space-lg pb-space-2xl">
      {/* Workspace Subheader & Workflow Progress Tracker */}
      <div className={`${glass.panel} ${glass.toolbar}`}>
        <span className={`${glass.label} ${glass.labelInk}`}>Bước 1 · Đọc hiểu đề bài và lập dàn ý</span>
        {/* Right Utility Meta Pill & Save Status */}
        <div className="flex items-center gap-space-sm flex-wrap">
          <div
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 border transition-all ${
              saveStatus === 'SAVED'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
                : saveStatus === 'SAVING'
                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30 animate-pulse'
                : saveStatus === 'SAVE_FAILED'
                ? 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30'
                : 'bg-surface-container text-on-surface-variant border-outline-variant/60'
            }`}
          >
            <span className="material-symbols-outlined text-[14px]">
              {saveStatus === 'SAVED'
                ? 'check_circle'
                : saveStatus === 'SAVING'
                ? 'sync'
                : saveStatus === 'SAVE_FAILED'
                ? 'error'
                : 'edit_note'}
            </span>
            <span>
              {saveStatus === 'SAVED'
                ? 'Đã lưu dàn ý ✓'
                : saveStatus === 'SAVING'
                ? 'Đang lưu dàn ý...'
                : saveStatus === 'SAVE_FAILED'
                ? 'Lưu thất bại'
                : 'Có thay đổi chưa lưu'}
            </span>
          </div>

          <div className="flex items-center gap-space-sm bg-surface-container px-space-sm py-1.5 rounded-lg text-on-surface-variant">
            <div className="w-2 h-2 rounded-full bg-secondary" />
            <span className="font-label-md text-label-md text-on-surface">{getCategoryLabel(task.category)}</span>
            {task.targetCefr && (
              <>
                <span className="text-outline-variant">•</span>
                <span className="font-label-stamp text-label-stamp uppercase px-1.5 py-0.5 rounded bg-surface-variant text-on-surface-variant font-bold">
                  {task.targetCefr}
                </span>
              </>
            )}
            <span className="text-outline-variant">•</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              {task.targetWordCountMin || 180}–{task.targetWordCountMax || 240} từ
            </span>
          </div>
        </div>
      </div>

      {transitionError && (
        <div className={`${glass.verdict} justify-between text-xs`} data-v="bad" role="alert">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span>{transitionError}</span>
          </div>
          <button
            onClick={() => setTransitionError(null)}
            className="hover:underline font-bold cursor-pointer"
          >
            Đóng
          </button>
        </div>
      )}

      {/* Main Two-Column Atelier Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-start">
        {/* LEFT COLUMN: Task Parameters & Rhetorical Brief (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-space-md">
          {/* Specification Card */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-xs flex flex-col gap-space-md relative overflow-hidden border border-surface-container-high/60">
            <div className="absolute top-0 left-0 w-1.5 h-full bg-primary-container" />
            <div className="flex items-center justify-between pl-space-xs">
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary-container text-[20px]">
                  assignment_turned_in
                </span>
                <span className="font-label-stamp text-label-stamp uppercase tracking-wider text-on-surface-variant">
                  Thông tin và Yêu cầu đề bài
                </span>
              </div>
              {task.targetCefr && (
                <span className="inline-flex items-center font-label-stamp text-label-stamp uppercase px-2.5 py-1 rounded-md bg-tertiary-fixed-dim/30 text-tertiary-container shadow-2xs">
                  Mục tiêu {task.targetCefr}
                </span>
              )}
            </div>

            <div className="pl-space-xs">
              <h2 className="font-display-hero text-headline-md text-on-surface italic leading-snug">
                “{task.title || 'Đề bài viết'}”
              </h2>
            </div>

            {/* Parameter Chips & Metadata */}
            <div className="pl-space-xs flex flex-col gap-space-sm bg-surface-container-low p-space-md rounded-lg border border-surface-container-high/40">
              <div className="flex items-start gap-space-sm">
                <span className="material-symbols-outlined text-outline text-[18px] mt-0.5">groups</span>
                <div className="flex flex-col">
                  <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                    Độc giả hướng tới
                  </span>
                  <span className="font-body-md text-body-md font-medium text-on-surface">
                    {task.audience || 'Độc giả học thuật tổng quát'}
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-space-sm">
                <span className="material-symbols-outlined text-outline text-[18px] mt-0.5">
                  record_voice_over
                </span>
                <div className="flex flex-col">
                  <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                    Văn phong và Sắc thái
                  </span>
                  <span className="font-body-md text-body-md font-medium text-on-surface">
                    Học thuật trang trọng / Lập luận cân bằng
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-space-sm">
                <span className="material-symbols-outlined text-outline text-[18px] mt-0.5">flag</span>
                <div className="flex flex-col">
                  <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                    Mục tiêu bài viết
                  </span>
                  <span className="font-body-md text-body-md text-on-surface">
                    {task.prompt || 'Tổng hợp các góc nhìn đối lập và khẳng định luận điểm rõ ràng, có căn cứ.'}
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-space-sm">
                <span className="material-symbols-outlined text-outline text-[18px] mt-0.5">straighten</span>
                <div className="flex flex-col">
                  <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                    Dung lượng mục tiêu
                  </span>
                  <span className="font-body-md text-body-md text-on-surface">
                    {task.targetWordCountMin || 180}–{task.targetWordCountMax || 240} từ
                  </span>
                </div>
              </div>
            </div>

            {/* Key Rhetorical Constraints */}
            {task.constraints && task.constraints.length > 0 && (
              <div className="pl-space-xs flex flex-col gap-space-xs">
                <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-on-surface-variant">
                  Yêu cầu lập luận trọng tâm
                </span>
                <div className="flex flex-col gap-space-xs">
                  {task.constraints.map((c: string, i: number) => (
                    <div key={i} className="flex items-center gap-space-sm p-space-xs bg-surface-container rounded-lg">
                      <span className="material-symbols-outlined text-tertiary-container text-[18px]">
                        verified
                      </span>
                      <span className="font-body-sm text-body-sm text-on-surface">{c}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Visual Data Representation for Task 1 */}
          {(task.visualData || session.taskSnapshot?.visualData) && (
            <TaskVisualChart visualData={task.visualData || session.taskSnapshot?.visualData} />
          )}

          {/* Dialectic / Task Structure Organization Guidepost Card */}
          <div className="bg-surface-container rounded-xl p-space-md flex items-center gap-space-md shadow-xs border border-surface-container-high/60">
            <div className="w-12 h-12 rounded-xl bg-primary-container text-on-primary flex items-center justify-center shrink-0 shadow-2xs">
              <span className="material-symbols-outlined text-[24px]">
                {isTask1 ? 'monitoring' : isTask2 ? 'balance' : 'edit_document'}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-headline-sm text-headline-sm text-on-surface">{planLabels.guideTitle}</span>
              <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
                {planLabels.guideText}
              </p>
            </div>
          </div>

          {/* Target Vocabulary Bank */}
          {task.targetWords && task.targetWords.length > 0 && (
            <div className="bg-surface-container-lowest rounded-xl p-space-md shadow-xs flex flex-col gap-space-xs border border-surface-container-high/60">
              <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                Từ vựng mục tiêu (Nhấn để thêm vào ghi chú)
              </span>
              <div className="flex flex-wrap gap-1.5 pt-space-2xs">
                {task.targetWords.map((phrase: string) => (
                  <button
                    key={phrase}
                    type="button"
                    onClick={() => {
                      const next = notesText ? `${notesText}, ${phrase}` : phrase;
                      handleNotesChange(next);
                    }}
                    className="px-space-xs py-1 rounded-full bg-surface-container text-on-surface-variant font-label-sm text-label-sm hover:bg-primary-fixed hover:text-primary transition-colors cursor-pointer"
                  >
                    + {phrase}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Learner Idea Canvas & Structuring (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-space-md">
          {/* Header Container */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-xs flex flex-col gap-space-sm border border-surface-container-high/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="material-symbols-outlined text-primary text-[22px]">schema</span>
                <h1 className="font-headline-md text-headline-md text-on-surface">
                  Xây dựng cấu trúc lập luận
                </h1>
              </div>
              <div className="flex items-center gap-space-xs text-tertiary-container bg-tertiary-fixed-dim/20 px-space-xs py-0.5 rounded">
                <span className="material-symbols-outlined text-[16px]">psychology</span>
                <span className="font-label-stamp text-label-stamp uppercase">Hướng dẫn tư duy độc lập</span>
              </div>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant">
              Ghi lại những ý tưởng sơ khởi bằng chính ngôn từ của bạn. Hệ thống sẽ hỗ trợ sắp xếp thành dàn ý mạch lạc mà không viết thay bạn.
            </p>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={handleAdvisorClick}
                disabled={loadingSocratic}
                className="px-3 py-1.5 rounded-lg border border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-xs"
                type="button"
              >
                <span className={`material-symbols-outlined text-[16px] ${loadingSocratic ? 'animate-spin [animation-direction:reverse]' : ''}`}>
                  {loadingSocratic ? 'sync' : 'supervisor_account'}
                </span>
                <span>{loadingSocratic ? 'Đang phân tích...' : 'Cố vấn tư duy'}</span>
              </button>

              <button
                onClick={handleOrganize}
                disabled={organizing || !planText.trim()}
                className="px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary-fixed/20 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-xs"
                type="button"
              >
                {organizing ? (
                  <span className="material-symbols-outlined text-[16px] animate-spin [animation-direction:reverse]">sync</span>
                ) : (
                  <img src={echoSrc('scholar', 24)} alt="Echo" width={16} height={16} className="w-4 h-4 object-contain shrink-0 select-none pointer-events-none" />
                )}
                <span>{organizing ? 'Đang sắp xếp...' : 'Sắp xếp dàn ý cùng AI'}</span>
              </button>
            </div>

            {socraticError && (
              <div className="mt-2 p-3 rounded-xl bg-error-container/20 border border-error/30 text-error text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  <span>{socraticError}</span>
                </div>
                <button
                  type="button"
                  onClick={handleAdvisorClick}
                  className="underline font-bold hover:text-error/80 cursor-pointer"
                >
                  Thử lại
                </button>
              </div>
            )}

            {organizeError && (
              <div className="mt-2 p-3 rounded-xl bg-error-container/20 border border-error/30 text-error text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  <span>{organizeError}</span>
                </div>
                <button
                  type="button"
                  onClick={handleOrganize}
                  className="underline font-bold hover:text-error/80 cursor-pointer"
                >
                  Thử lại
                </button>
              </div>
            )}
          </div>

          {/* Cố vấn tư duy Loading State */}
          {loadingSocratic && !socraticResult && (
            <div className="p-6 rounded-2xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-300/80 dark:border-amber-800/60 flex items-center justify-center gap-3 py-8 animate-in fade-in duration-200 shadow-sm">
              <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-[24px] animate-spin [animation-direction:reverse]">
                sync
              </span>
              <span className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Cố vấn tư duy đang phân tích ý tưởng của bạn...
              </span>
            </div>
          )}

          {/* Cố vấn tư duy Compact Collapsed Header */}
          {showSocratic && socraticResult && isAdvisorCollapsed && (
            <div className="p-4 rounded-xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-300/80 dark:border-amber-800/60 shadow-xs flex items-center justify-between animate-in fade-in duration-200">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-[20px]">
                  supervisor_account
                </span>
                <span className="font-headline-sm text-headline-sm font-bold text-amber-900 dark:text-amber-200">
                  Cố vấn tư duy
                </span>
                {socraticResult.suggested_items && socraticResult.suggested_items.length > 0 && (
                  <span className="text-[11px] bg-amber-200 dark:bg-amber-900 text-amber-900 dark:text-amber-100 px-2 py-0.5 rounded-full font-medium">
                    {socraticResult.suggested_items.length} gợi ý
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleGetSocraticGuidance(true)}
                  disabled={loadingSocratic}
                  className="text-xs px-2.5 py-1 rounded-lg border border-amber-500/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100/60 font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[14px] ${loadingSocratic ? 'animate-spin [animation-direction:reverse]' : ''}`}>
                    {loadingSocratic ? 'sync' : 'refresh'}
                  </span>
                  <span>{loadingSocratic ? 'Đang tải...' : 'Làm mới gợi ý'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsAdvisorCollapsed(false)}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg cursor-pointer shadow-2xs flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-[16px]">expand_more</span>
                  <span>Mở rộng</span>
                </button>
              </div>
            </div>
          )}

          {/* Cố vấn tư duy Guidance Panel (Yellow Panel) */}
          {showSocratic && socraticResult && !isAdvisorCollapsed && (
            <div id="socratic-advisor-panel" className="p-6 rounded-2xl bg-amber-50/80 dark:bg-amber-950/40 border border-amber-300/80 dark:border-amber-800/60 space-y-4 shadow-sm animate-in fade-in duration-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-amber-600 dark:text-amber-400 text-[20px]">
                    supervisor_account
                  </span>
                  <h4 className="font-headline-sm text-headline-sm font-bold text-amber-900 dark:text-amber-200">
                    Cố vấn tư duy
                  </h4>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleGetSocraticGuidance(true)}
                    disabled={loadingSocratic}
                    className="text-xs px-2.5 py-1 rounded-lg border border-amber-500/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100/60 font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    type="button"
                  >
                    <span className={`material-symbols-outlined text-[14px] ${loadingSocratic ? 'animate-spin' : ''}`}>
                      {loadingSocratic ? 'sync' : 'refresh'}
                    </span>
                    <span>Làm mới</span>
                  </button>
                  <button
                    onClick={() => setIsAdvisorCollapsed(true)}
                    className="text-xs text-amber-700 dark:text-amber-400 hover:underline cursor-pointer font-medium"
                    type="button"
                  >
                    Thu gọn
                  </button>
                </div>
              </div>

              {socraticResult.encouragement && (
                <p className="text-xs text-amber-900 dark:text-amber-200 italic bg-amber-100/50 dark:bg-amber-900/30 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800/40">
                  &quot;{socraticResult.encouragement}&quot;
                </p>
              )}

              {socraticToast && (
                <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 p-2 rounded-lg border border-emerald-300/60 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-emerald-600">check_circle</span>
                  <span>{socraticToast}</span>
                </div>
              )}

              {/* ACTIONABLE PLAN SUGGESTIONS SECTION */}
              {socraticResult.suggested_items && socraticResult.suggested_items.length > 0 && (
                <div className="p-4 rounded-xl bg-surface-container-lowest border-2 border-amber-400/80 dark:border-amber-700 shadow-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[18px] text-amber-600">add_task</span>
                      <span>Đề xuất đưa vào dàn ý (Chọn để áp dụng)</span>
                    </span>
                    <span className="text-[11px] text-amber-700/80 font-medium">
                      {socraticResult.suggested_items.length} gợi ý
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {socraticResult.suggested_items.map((item) => {
                      const isAdded = isSuggestionInOutline(item.content);
                      return (
                        <div
                          key={item.id}
                          className="p-3 rounded-lg bg-amber-50/60 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                                  item.operation === 'COUNTERARGUMENT' || item.section === 'counterargument'
                                    ? 'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100'
                                    : item.operation === 'EVIDENCE'
                                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200'
                                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200'
                                }`}
                              >
                                {item.operation === 'COUNTERARGUMENT'
                                  ? 'Phản biện'
                                  : item.operation === 'EVIDENCE'
                                  ? 'Dẫn chứng'
                                  : 'Gợi ý ý tưởng'}
                              </span>
                              {newSuggestionIds.has(item.id) && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500 text-white shadow-2xs">
                                  Mới
                                </span>
                              )}
                              {item.reasoning && (
                                <span className="text-[11px] text-amber-800/80 dark:text-amber-300/80 italic">
                                  {item.reasoning}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-on-surface font-medium leading-relaxed">
                              {item.content}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleApplySuggestion(item)}
                            disabled={isAdded}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 cursor-pointer shadow-2xs flex items-center gap-1 ${
                              isAdded
                                ? 'bg-emerald-600 text-white cursor-default opacity-90'
                                : 'bg-amber-600 hover:bg-amber-700 text-white'
                            }`}
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              {isAdded ? 'check' : 'add'}
                            </span>
                            <span>{isAdded ? 'Đã thêm' : 'Thêm vào dàn ý'}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Socratic Questions & Prompts Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                {/* Probing Questions */}
                <div className="p-4 rounded-xl bg-surface-container-lowest border border-amber-200/80 dark:border-amber-900/50 space-y-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">help</span>
                    <span>Câu hỏi gợi mở tư duy</span>
                  </span>
                  <div className="space-y-2">
                    {socraticResult.probing_questions.map((q, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-xs text-on-surface flex items-start justify-between gap-2"
                      >
                        <span className="leading-relaxed">{q}</span>
                        <button
                          type="button"
                          onClick={() => handleAppendToPlan(`Consider: ${q}`)}
                          className="text-xs font-bold text-amber-700 dark:text-amber-400 hover:underline shrink-0 cursor-pointer"
                        >
                          Thêm vào dàn ý
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Structural Prompts */}
                <div className="p-4 rounded-xl bg-surface-container-lowest border border-amber-200/80 dark:border-amber-900/50 space-y-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">lightbulb</span>
                    <span>Gợi ý cấu trúc đoạn văn</span>
                  </span>
                  <div className="space-y-2">
                    {socraticResult.structural_prompts.map((p, idx) => (
                      <div
                        key={idx}
                        className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-xs text-on-surface flex items-start justify-between gap-2"
                      >
                        <span className="leading-relaxed">{p}</span>
                        <button
                          type="button"
                          onClick={() => handleAppendToPlan(`Outline: ${p}`)}
                          className="text-xs font-bold text-amber-700 dark:text-amber-400 hover:underline shrink-0 cursor-pointer"
                        >
                          Thêm vào dàn ý
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Socratic Chat / Query Input */}
              <div className="flex gap-2 pt-2 border-t border-amber-200/60 dark:border-amber-900/40">
                <input
                  type="text"
                  value={socraticQuestion}
                  onChange={(e) => setSocraticQuestion(e.target.value)}
                  placeholder="Hỏi hoặc yêu cầu thêm ý (ví dụ: Thêm phản biện về việc học sinh phụ thuộc vào AI...)"
                  className="flex-1 text-xs px-3.5 py-2.5 rounded-xl border border-amber-300 dark:border-amber-800 bg-surface-container-lowest text-on-surface placeholder:text-outline/60 focus:outline-hidden focus:ring-2 focus:ring-amber-500 shadow-inner"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleGetSocraticGuidance(true);
                  }}
                />
                <button
                  onClick={() => handleGetSocraticGuidance(true)}
                  disabled={loadingSocratic}
                  className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl cursor-pointer disabled:opacity-50 shadow-xs flex items-center gap-1"
                  type="button"
                >
                  <span className={`material-symbols-outlined text-[16px] ${loadingSocratic ? 'animate-spin [animation-direction:reverse]' : ''}`}>
                    {loadingSocratic ? 'sync' : 'send'}
                  </span>
                  <span>{loadingSocratic ? 'Đang gửi...' : 'Gửi'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Section 1: Thesis / Introduction */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-xs flex flex-col gap-space-sm border border-surface-container-high/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-sm">
                <span className="w-6 h-6 rounded-full bg-primary-fixed text-primary flex items-center justify-center font-label-stamp text-label-stamp font-bold">
                  01
                </span>
                <label className="font-headline-sm text-headline-sm text-on-surface" htmlFor="thesis-input">
                  {planLabels.thesisLabel}
                </label>
              </div>
              <span className="font-body-sm text-body-sm text-on-surface-variant">{planLabels.thesisBadge}</span>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {planLabels.thesisDesc}
            </p>
            <textarea
              id="thesis-input"
              rows={2}
              value={thesisText}
              onChange={(e) => handleThesisChange(e.target.value)}
              placeholder={planLabels.thesisPlaceholder}
              className="w-full bg-surface-container-low text-on-surface font-body-md text-body-md p-space-md rounded-lg focus:outline-hidden focus:bg-surface-container-lowest focus:ring-2 focus:ring-primary transition-all resize-none shadow-inner"
            />
          </div>

          {/* Section 2: Building Blocks (Propositions A, B, C) */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-xs flex flex-col gap-space-md border border-surface-container-high/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-sm">
                <span className="w-6 h-6 rounded-full bg-primary-fixed text-primary flex items-center justify-center font-label-stamp text-label-stamp font-bold">
                  02
                </span>
                <h2 className="font-headline-sm text-headline-sm text-on-surface">
                  {planLabels.sectionTitle}
                </h2>
              </div>
              <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                Các phần triển khai
              </span>
            </div>

            {/* Proposition A */}
            <div className="flex flex-col gap-space-xs bg-surface-container-low p-space-md rounded-lg">
              <div className="flex items-center justify-between">
                <span className="font-label-stamp text-label-stamp uppercase bg-secondary-fixed text-secondary px-2 py-0.5 rounded font-bold">
                  {planLabels.propALabel}
                </span>
                <span className="font-body-sm text-body-sm text-outline-variant">{planLabels.propABadge}</span>
              </div>
              <textarea
                value={propA}
                onChange={(e) => handlePropAChange(e.target.value)}
                placeholder={planLabels.propAPlaceholder}
                rows={2}
                className="w-full bg-surface-container-lowest text-on-surface font-body-md text-body-md p-space-sm rounded-lg focus:outline-hidden focus:ring-2 focus:ring-secondary transition-all resize-none shadow-inner"
              />
              <span className="font-label-stamp text-[10px] text-secondary">
                {planLabels.propAHoursHint}
              </span>
            </div>

            {/* Proposition B */}
            <div className="flex flex-col gap-space-xs bg-surface-container-low p-space-md rounded-lg">
              <div className="flex items-center justify-between">
                <span className="font-label-stamp text-label-stamp uppercase bg-primary-fixed text-primary px-2 py-0.5 rounded font-bold">
                  {planLabels.propBLabel}
                </span>
                <span className="font-body-sm text-body-sm text-outline-variant">{planLabels.propBBadge}</span>
              </div>
              <textarea
                value={propB}
                onChange={(e) => handlePropBChange(e.target.value)}
                placeholder={planLabels.propBPlaceholder}
                rows={2}
                className="w-full bg-surface-container-lowest text-on-surface font-body-md text-body-md p-space-sm rounded-lg focus:outline-hidden focus:ring-2 focus:ring-primary transition-all resize-none shadow-inner"
              />
              <span className="font-label-stamp text-[10px] text-primary">
                {planLabels.propBHoursHint}
              </span>
            </div>

            {/* Proposition C */}
            <div className="flex flex-col gap-space-xs bg-surface-container-low p-space-md rounded-lg">
              <div className="flex items-center justify-between">
                <span className="font-label-stamp text-label-stamp uppercase bg-tertiary-fixed text-tertiary px-2 py-0.5 rounded font-bold">
                  {planLabels.propCLabel}
                </span>
                <span className="font-body-sm text-body-sm text-outline-variant">{planLabels.propCBadge}</span>
              </div>
              <textarea
                value={propC}
                onChange={(e) => handlePropCChange(e.target.value)}
                placeholder={planLabels.propCPlaceholder}
                rows={2}
                className="w-full bg-surface-container-lowest text-on-surface font-body-md text-body-md p-space-sm rounded-lg focus:outline-hidden focus:ring-2 focus:ring-tertiary transition-all resize-none shadow-inner"
              />
              <span className="font-label-stamp text-[10px] text-tertiary">
                {planLabels.propCHoursHint}
              </span>
            </div>

            {/* User Notes & Evidence */}
            <div className="flex flex-col gap-space-xs bg-surface-container-low p-space-md rounded-lg">
              <div className="flex items-center justify-between">
                <span className="font-label-stamp text-label-stamp uppercase bg-surface-container-high text-on-surface-variant px-2 py-0.5 rounded font-bold">
                  Ghi chú cá nhân và Dẫn chứng thực tế
                </span>
                <span className="font-body-sm text-body-sm text-outline-variant">Tùy chọn</span>
              </div>
              <textarea
                value={notesText}
                onChange={(e) => handleNotesChange(e.target.value)}
                placeholder="Ghi chú ví dụ thực tế, số liệu hoặc từ vựng muốn áp dụng..."
                rows={2}
                className="w-full bg-surface-container-lowest text-on-surface font-body-md text-body-md p-space-sm rounded-lg focus:outline-hidden focus:ring-2 focus:ring-primary transition-all resize-none shadow-inner"
              />
            </div>
          </div>

          {/* Master Outline View */}
          <div className="bg-surface-container-lowest rounded-xl p-space-lg shadow-xs flex flex-col gap-space-xs border border-surface-container-high/60">
            <div className="flex items-center justify-between">
              <span className="font-label-stamp text-label-stamp uppercase text-on-surface-variant">
                Dàn ý chi tiết (Đồng bộ với màn hình viết nháp)
              </span>
              <span className="text-xs text-outline">
                {planText.length} ký tự
              </span>
            </div>
            <textarea
              value={planText}
              onChange={(e) => handlePlanTextDirectChange(e.target.value)}
              rows={5}
              placeholder="Dàn ý hoàn chỉnh của bạn..."
              className="w-full p-4 font-mono text-xs text-on-surface bg-surface-container-low rounded-xl border border-surface-container-high focus:outline-hidden focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Bottom Action Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-space-sm pt-space-xs">
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={onBackToTask}
                className="px-space-md py-2.5 min-h-[42px] rounded-xl border border-outline-variant/70 hover:bg-surface-container text-on-surface font-semibold text-sm transition-colors cursor-pointer shadow-xs"
                type="button"
              >
                ← Quay lại chọn đề
              </button>

              <button
                onClick={handleSaveWorkingCopy}
                disabled={saveStatus === 'SAVING'}
                className={`px-space-md py-2.5 min-h-[42px] rounded-xl border font-semibold text-sm flex items-center justify-center gap-space-xs transition-colors cursor-pointer disabled:opacity-50 shadow-xs ${
                  saveStatus === 'SAVED'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                    : saveStatus === 'SAVE_FAILED'
                    ? 'bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300'
                    : saveStatus === 'SAVING'
                    ? 'bg-surface-container border-outline-variant/60 text-on-surface'
                    : 'bg-primary-container border-primary/40 text-on-primary-container hover:bg-primary-container/80'
                }`}
                type="button"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {saveStatus === 'SAVING'
                    ? 'sync'
                    : saveStatus === 'SAVED'
                    ? 'check_circle'
                    : saveStatus === 'SAVE_FAILED'
                    ? 'error'
                    : 'save'}
                </span>
                <span>
                  {saveStatus === 'SAVING'
                    ? 'Đang lưu...'
                    : saveStatus === 'SAVED'
                    ? 'Đã lưu dàn ý ✓'
                    : saveStatus === 'SAVE_FAILED'
                    ? 'Lưu thất bại — Thử lại'
                    : 'Lưu dàn ý'}
                </span>
              </button>
            </div>

            {hasContent ? (
              <button
                onClick={handleProceedToDrafting}
                disabled={advancing}
                className="w-full sm:w-auto px-6 py-2.5 min-h-[42px] rounded-xl bg-primary hover:opacity-95 text-white dark:text-on-primary font-semibold text-sm flex items-center justify-center gap-space-sm shadow-md active:translate-y-0.5 transition-all cursor-pointer disabled:opacity-50"
                type="button"
              >
                {advancing ? (
                  <>
                    <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
                    <span>Đang chuyển sang viết nháp...</span>
                  </>
                ) : (
                  <>
                    <span>Chốt dàn ý và Bắt đầu viết nháp</span>
                    <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={handleProceedToDrafting}
                disabled={advancing}
                className="w-full sm:w-auto px-5 py-2.5 min-h-[42px] rounded-xl border border-outline-variant/80 hover:bg-surface-container text-on-surface-variant font-semibold text-sm flex items-center justify-center gap-space-xs transition-colors cursor-pointer disabled:opacity-50"
                type="button"
              >
                {advancing ? (
                  <>
                    <span className="material-symbols-outlined text-[18px] animate-spin">sync</span>
                    <span>Đang chuyển sang viết nháp...</span>
                  </>
                ) : (
                  <>
                    <span>Bỏ qua dàn ý và Viết nháp ngay</span>
                    <span className="material-symbols-outlined text-[18px]">fast_forward</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
