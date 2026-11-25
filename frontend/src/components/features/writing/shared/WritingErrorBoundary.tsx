'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

import { glass } from '../glass/WritingGlass';
interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class WritingErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[WritingErrorBoundary] Caught unhandled writing exception:', error, errorInfo);
  }

  private handleRetry = () => {
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
            Không gian viết gặp sự cố gián đoạn
          </h3>
          <p className={glass.stateText}>
            Nội dung bản nháp của bạn đã được giữ an toàn trong bộ nhớ tạm trình duyệt. Nhấn nút bên dưới để tải lại không gian viết.
          </p>
          <Button onClick={this.handleRetry} className={`${glass.btn} ${glass.btnPrimary}`}>
            <RefreshCw className="w-4 h-4" />
            Tải lại không gian viết
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
