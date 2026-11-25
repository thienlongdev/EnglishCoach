'use client';

import React, { useEffect } from 'react';
import { AlertCircle, RotateCcw, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function ResultError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Exam result route error caught by boundary:', error);
    // Auto-retry once after 2 seconds to seamlessly recover from transient scoring delays
    const timer = setTimeout(() => {
      reset();
    }, 2000);
    return () => clearTimeout(timer);
  }, [error, reset]);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 p-8 text-center select-none">
      <AlertCircle className="w-12 h-12 text-amber-500 animate-pulse" />
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-foreground">
          Đang tải kết quả bài thi...
        </h2>
        <p className="text-xs text-muted-foreground max-w-md">
          Hệ thống đang hoàn tất tổng hợp bảng điểm bài thi. Trang sẽ tự động làm mới trong giây lát...
        </p>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => reset()}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-semibold hover:bg-primary/90 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Tải lại kết quả ngay
        </button>
        <Link
          href="/exams/ielts"
          className="inline-flex items-center gap-1.5 px-4 py-2 border border-input rounded-lg text-xs font-semibold hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Quay lại Thư viện
        </Link>
      </div>
    </div>
  );
}
