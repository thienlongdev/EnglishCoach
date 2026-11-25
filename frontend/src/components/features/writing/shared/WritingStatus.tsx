'use strict';

import React from 'react';
import { Loader2, CheckCircle2, AlertCircle, Clock, CloudOff } from 'lucide-react';
import { glass } from '../glass/WritingGlass';

export type SaveStatus = 'SAVED' | 'SAVING' | 'UNSAVED' | 'CONFLICT' | 'OFFLINE';

interface WritingStatusProps {
  status: SaveStatus;
  lastSavedAt?: number | null;
  className?: string;
}

export const WritingStatusBadge: React.FC<WritingStatusProps> = ({ status, className = '' }) => {
  let icon = <CheckCircle2 className="w-3.5 h-3.5" />;
  let label = 'Đã lưu trên đám mây';
  let tone = glass.chipOk;

  if (status === 'SAVING') {
    icon = <Loader2 className="w-3.5 h-3.5 animate-spin" />;
    label = 'Đang lưu...';
    tone = glass.chipInk;
  } else if (status === 'UNSAVED') {
    icon = <Clock className="w-3.5 h-3.5" />;
    label = 'Chưa lưu thay đổi';
    tone = glass.chipWarn;
  } else if (status === 'CONFLICT') {
    icon = <AlertCircle className="w-3.5 h-3.5" />;
    label = 'Xung đột đồng bộ (cần tải lại)';
    tone = glass.chipBad;
  } else if (status === 'OFFLINE') {
    icon = <CloudOff className="w-3.5 h-3.5" />;
    label = 'Chỉ lưu trên thiết bị';
    tone = '';
  }

  return (
    <div className={`${glass.chip} ${tone} ${className}`} role="status" aria-live="polite">
      {icon}
      <span>{label}</span>
    </div>
  );
};
