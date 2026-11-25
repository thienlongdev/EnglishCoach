'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, ChevronLeft } from 'lucide-react';

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ReadingErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error?.message || 'Lỗi không xác định' };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ReadingErrorBoundary] Caught unhandled reading exception:', error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 my-10 max-w-xl mx-auto rounded-3xl bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-900/40 text-center shadow-lg">
          <div className="inline-flex p-3 rounded-2xl bg-amber-100/80 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 mb-4">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">
            Không thể tải giao diện bài đọc lúc này
          </h3>
          <p className="text-xs text-stone-600 dark:text-slate-300 mb-6 max-w-md mx-auto leading-relaxed">
            Dữ liệu đọc và ghi chú của bạn vẫn an toàn. Vui lòng thử tải lại hoặc quay về kho tài liệu đọc.
          </p>
          <div className="flex items-center justify-center gap-3">
            {this.props.onReset && (
              <button
                type="button"
                onClick={this.props.onReset}
                className="px-4 py-2 rounded-xl border border-stone-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-stone-700 dark:text-slate-200 text-xs font-semibold hover:bg-stone-100 transition inline-flex items-center gap-1.5 cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Kho tài liệu</span>
              </button>
            )}
            <button
              type="button"
              onClick={this.handleRetry}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition inline-flex items-center gap-1.5 cursor-pointer shadow-md shadow-indigo-600/20"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Thử lại</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
