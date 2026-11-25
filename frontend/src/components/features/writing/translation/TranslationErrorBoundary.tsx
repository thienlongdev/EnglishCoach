'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { glass } from '../glass/WritingGlass';
interface Props {
  children: ReactNode;
  fallbackDraft?: string;
  onRecoverDraft?: (draft: string) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class TranslationErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('TranslationErrorBoundary caught an error:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className={`${glass.panel} ${glass.state} my-6 max-w-lg mx-auto`} data-kind="error" role="alert">
          <div className={glass.stateIcon}>
            <AlertTriangle />
          </div>
          <h3 className={glass.stateTitle}>
            Đã xảy ra lỗi trong phần Luyện dịch
          </h3>
          <p className={glass.stateText}>
            Nội dung bài làm của bạn đã được bảo vệ trên thiết bị. Bạn có thể thử tải lại phiên làm việc.
          </p>

          {this.props.fallbackDraft && (
            <div className="p-3 bg-surface-container rounded-xl text-left font-mono text-xs text-on-surface-variant max-h-32 overflow-y-auto border border-surface-container-high/60">
              <span className="text-secondary font-semibold block mb-1">Bản thảo gần nhất:</span>
              {this.props.fallbackDraft}
            </div>
          )}

          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={this.handleReset}
              className={`${glass.btn} ${glass.btnPrimary}`}
            >
              <RefreshCw className="w-4 h-4" />
              <span>Thử lại</span>
            </button>
            {this.props.fallbackDraft && this.props.onRecoverDraft && (
              <button
                type="button"
                onClick={() => {
                  this.props.onRecoverDraft?.(this.props.fallbackDraft!);
                  this.handleReset();
                }}
                className={`${glass.btn} ${glass.btnSoft}`}
              >
                Khôi phục bản thảo
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
