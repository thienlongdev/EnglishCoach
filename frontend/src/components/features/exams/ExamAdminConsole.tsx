'use client';

import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardList, FileCheck2, FlaskConical, GitCompare, ShieldAlert, UserCheck } from 'lucide-react';
import { ExamAdminCalibrationPanel } from './ExamAdminCalibrationPanel';
import { ExamAdminContentPanel } from './ExamAdminContentPanel';
import { ExamAdminOperationsPanel } from './ExamAdminOperationsPanel';
import { ExamAdminPilotPanel } from './ExamAdminPilotPanel';
import { ExamAdminRaterPanel } from './ExamAdminRaterPanel';

export type AdminMessage = { text: string; type: 'success' | 'error' };

type AdminPanel = 'OPERATIONS' | 'CONTENT' | 'PILOT' | 'RATERS' | 'CALIBRATION';

const tabs: Array<{ id: AdminPanel; label: string; icon: React.ReactNode }> = [
  { id: 'OPERATIONS', label: 'Operations center', icon: <ClipboardList className="h-4 w-4" /> },
  { id: 'CONTENT', label: 'Content import and release', icon: <FileCheck2 className="h-4 w-4" /> },
  { id: 'PILOT', label: 'Pilot measurement', icon: <FlaskConical className="h-4 w-4" /> },
  { id: 'RATERS', label: 'Human ratings and gold', icon: <UserCheck className="h-4 w-4" /> },
  { id: 'CALIBRATION', label: 'Calibration and scorer eval', icon: <GitCompare className="h-4 w-4" /> },
];

export const ExamAdminConsole: React.FC = () => {
  const [activePanel, setActivePanel] = useState<AdminPanel>('OPERATIONS');
  const [message, setMessage] = useState<AdminMessage | null>(null);

  const report = (next: AdminMessage) => setMessage(next);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-rose-500">
            <ShieldAlert className="h-4 w-4" /> Restricted operator console
          </span>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Exams content and measurement</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Every action below calls the authenticated Exams admin API. Validation, consent, provenance, split, and approval gates remain server enforced.
          </p>
        </div>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Imported IDs and measurement IDs are the source of truth. No placeholder catalog or synthetic success state is shown.
        </div>
      </header>

      {message && (
        <div className={`flex items-start gap-2 rounded-md border p-3 text-xs font-semibold ${message.type === 'success'
          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300'}`}>
          {message.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      <nav className="grid gap-2 border-b border-border pb-2 sm:grid-cols-3 lg:grid-cols-5" aria-label="Exams administration sections">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => { setActivePanel(tab.id); setMessage(null); }}
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-bold transition-colors ${activePanel === tab.id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      {activePanel === 'OPERATIONS' && <ExamAdminOperationsPanel onMessage={report} />}
      {activePanel === 'CONTENT' && <ExamAdminContentPanel onMessage={report} />}
      {activePanel === 'PILOT' && <ExamAdminPilotPanel onMessage={report} />}
      {activePanel === 'RATERS' && <ExamAdminRaterPanel onMessage={report} />}
      {activePanel === 'CALIBRATION' && <ExamAdminCalibrationPanel onMessage={report} />}
    </div>
  );
};

