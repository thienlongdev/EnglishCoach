'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

import { glass } from '../glass/WritingGlass';
interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class SentenceLabErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error?.message || 'Lỗi xử lý trong Sentence Lab' };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[SentenceLabErrorBoundary] Caught Sentence Lab exception:', error, errorInfo);
  }

  private handleRetry = () => {
    if (this.props.onReset) {
      try {
        this.props.onReset();
      } catch (err) {
        console.warn('Error during SentenceLabErrorBoundary reset callback:', err);
      }
    }
    this.setState({ hasError: false, errorMessage: '' });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className={`${glass.panel} ${glass.state} my-6 max-w-2xl mx-auto`} data-kind="error" role="alert">
          <div className={glass.stateIcon}>
            <AlertTriangle />
          </div>
          <h3 className={glass.stateTitle}>
            Sentence Lab gặp gián đoạn tạm thời
          </h3>
          <p className={glass.stateText}>
            Bản nháp câu của bạn đã được giữ an toàn trong bộ nhớ tạm. Bạn có thể thử tải lại Sentence Lab bên dưới, hoặc chuyển sang các tab khác trong thanh điều hướng phía trên.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button
              onClick={this.handleRetry}
              className={`${glass.btn} ${glass.btnPrimary}`}
            >
              <RefreshCw className="w-4 h-4" />
              Thử lại Sentence Lab
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
