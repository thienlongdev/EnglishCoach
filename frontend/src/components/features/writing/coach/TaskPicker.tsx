'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { WritingTask } from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import { getCategoryLabel } from '@/lib/writing/labels';
import { PenLine, Library, Layers, ArrowRight, BookOpenCheck, PencilLine } from 'lucide-react';
import { WritingHero, Glyph, StatePanel, FAMILY_TONES, glass } from '../glass/WritingGlass';
import { echoSrc } from '@/lib/brand/echoCharacters';

interface TaskPickerProps {
  onSelectTask: (task: WritingTask) => void;
  creating: boolean;
}

const CANONICAL_CATEGORIES = [
  { id: 'all', label: 'Tất cả đề bài' },
  { id: 'IELTS_TASK_1', label: 'IELTS Task 1' },
  { id: 'IELTS_TASK_2', label: 'IELTS Task 2' },
  { id: 'TOEIC_WRITING', label: 'TOEIC Writing' },
  { id: 'GENERAL_ACADEMIC', label: 'General / Academic' },
] as const;

export function getCanonicalFamily(task: WritingTask): string {
  if (
    task.family === 'IELTS_TASK_1' ||
    task.id.startsWith('ielts-t1-') ||
    (task.family === 'IELTS' &&
      task.taskSubtype &&
      ['line_chart', 'bar_chart', 'pie_chart', 'table', 'process', 'map', 'mixed_data', 'mixed_chart'].includes(
        task.taskSubtype
      ))
  ) {
    return 'IELTS_TASK_1';
  }
  if (task.family === 'IELTS_TASK_2' || task.id.startsWith('ielts-t2-') || task.family === 'IELTS') {
    return 'IELTS_TASK_2';
  }
  if (task.family === 'TOEIC_WRITING' || task.id.startsWith('toeic-') || task.family === 'TOEIC') {
    return 'TOEIC_WRITING';
  }
  return 'GENERAL_ACADEMIC';
}

export const TaskPicker: React.FC<TaskPickerProps> = ({ onSelectTask, creating }) => {
  const [allTasks, setAllTasks] = useState<WritingTask[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await writingApi.getTasks();
      setAllTasks(data);
    } catch (err: any) {
      console.error('Failed to load tasks', err);
      setError(
        err.response?.data?.message ||
        'Không thể tải danh sách đề bài viết. Vui lòng kiểm tra kết nối và thử lại.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const categoryCounts = React.useMemo(() => {
    const counts: Record<string, number> = {
      all: allTasks.length,
      IELTS_TASK_1: 0,
      IELTS_TASK_2: 0,
      TOEIC_WRITING: 0,
      GENERAL_ACADEMIC: 0,
    };
    for (const t of allTasks) {
      const cat = getCanonicalFamily(t);
      if (counts[cat] !== undefined) {
        counts[cat]++;
      }
    }
    return counts;
  }, [allTasks]);

  const filteredTasks = React.useMemo(() => {
    if (selectedCategory === 'all') return allTasks;
    return allTasks.filter((t) => getCanonicalFamily(t) === selectedCategory);
  }, [allTasks, selectedCategory]);

  const spotlightTask = filteredTasks[0] || null;
  const remainingTasks = filteredTasks.slice(1);

  const familiesPresent = CANONICAL_CATEGORIES.filter((c) => c.id !== 'all' && (categoryCounts[c.id] ?? 0) > 0).length;
  const spotIdentity = spotlightTask ? FAMILY_TONES[getCanonicalFamily(spotlightTask)] : null;

  return (
    <div className={`${glass.stack} pb-6`}>
      <WritingHero
        world="coach"
        titleId="coach-hero-title"
        eyebrow="Writing Coach · Đề bài chọn lọc"
        eyebrowIcon={<PenLine aria-hidden="true" />}
        title="Đề bài chọn lọc cho"
        accent="tư duy sâu sắc"
        lead="Lựa chọn bài tập viết có định hướng phù hợp với thể loại văn bản thực tế. Không tạo bài mẫu tự động; hãy lập dàn ý và diễn đạt với cấu trúc mạch lạc."
        stats={!loading && !error ? [
          { value: allTasks.length, label: 'Đề bài chọn lọc', icon: <Library aria-hidden="true" /> },
          { value: familiesPresent, label: 'Thể loại', icon: <Layers aria-hidden="true" /> },
        ] : []}
      />

      {/* Error State with Retry */}
      {error && !loading && (
        <StatePanel
          kind="error"
          icon={<span className="material-symbols-outlined text-[28px]">error</span>}
          title="Không thể tải danh sách đề bài"
          text={error}
          actions={
            <button onClick={loadTasks} className={`${glass.btn} ${glass.btnPrimary}`}>
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              <span>Thử tải lại</span>
            </button>
          }
        />
      )}

      {/* Loading Skeletons */}
      {loading && (
        <div className={glass.stack} aria-busy="true">
          <div className={glass.skeleton} style={{ minHeight: '14rem' }} />
          <div className={glass.grid}>
            {[1, 2, 3].map((i) => <div key={i} className={glass.skeleton} />)}
          </div>
        </div>
      )}

      {/* SECTION 1: Dominant Recommended Spotlight Card */}
      {!loading && spotlightTask && (
        <section className={`${glass.panel} ${glass.spotlight}`} aria-labelledby="coach-spotlight-title">
          <div className="relative flex flex-col gap-5">
            {/* Top Metatags */}
            <div className="flex flex-wrap items-center justify-between gap-space-sm">
              <div className="flex flex-wrap items-center gap-3">
                {spotIdentity && <Glyph tone={spotIdentity.tone} icon={spotIdentity.icon} small />}
                <span className={`${glass.chip} ${glass.chipInk}`}>
                  Gợi ý · {getCategoryLabel(spotlightTask.category)}
                </span>
                <span className={glass.chip}>{spotlightTask.targetWordCountMin}–{spotlightTask.targetWordCountMax} từ</span>
              </div>
              <div className="flex items-center gap-space-xs text-outline">
                <img src={echoSrc('scholar', 24)} alt="Echo" width={18} height={18} className="w-[18px] h-[18px] object-contain shrink-0 select-none pointer-events-none" />
                <span className="font-label-stamp text-label-stamp uppercase tracking-wider">
                  Chương trình chọn lọc
                </span>
              </div>
            </div>

            {/* Prominent Editorial Prompt Title */}
            <div className="flex flex-col gap-space-sm">
              <h2 id="coach-spotlight-title" className={glass.spotTitle}>
                {spotlightTask.title}
              </h2>
              <p className={glass.spotPrompt} lang="en">
                {spotlightTask.prompt}
              </p>
            </div>

            {/* Target Micro-Skills Section */}
            {spotlightTask.constraints && spotlightTask.constraints.length > 0 && (
              <div className="flex flex-col gap-space-xs pt-space-xs">
                <span className={glass.label}>
                  Yêu cầu bài viết
                </span>
                <div className="flex flex-wrap items-center gap-space-xs">
                  {spotlightTask.constraints.map((c: string, i: number) => (
                    <div
                      key={i}
                      className={glass.chip}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true" />
                      <span>{c}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Interactive Action Strip */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-outline-variant/40">
              <div className="flex items-center gap-space-sm">
                <button
                  disabled={creating}
                  onClick={() => onSelectTask(spotlightTask)}
                  className={`${glass.btn} ${glass.btnPrimary}`}
                  type="button"
                >
                  <span>{creating ? 'Đang khởi tạo...' : 'Bắt đầu bài viết'}</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
              <div className="flex items-center gap-space-md text-on-surface-variant font-body-sm text-body-sm">
                <span className="flex items-center gap-1.5">
                  <BookOpenCheck className="w-4 h-4 text-tertiary" aria-hidden="true" />
                  Đọc hiểu và Lập dàn ý
                </span>
                <span className="flex items-center gap-1.5">
                  <PencilLine className="w-4 h-4 text-primary" aria-hidden="true" />
                  Viết nháp và Tự sửa lỗi
                </span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* SECTION 2: Category Stream Switcher Bar */}
      <div className="w-full flex flex-col gap-3 pt-1">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-bold text-on-surface">
            Các chủ đề bài viết chọn lọc
          </h2>
          <span className={glass.chip}>
            {filteredTasks.length} đề bài có sẵn
          </span>
        </div>

        {/* Pill Tabs */}
        <div className={`${glass.seg} w-fit`} role="group" aria-label="Thể loại đề bài">
          {CANONICAL_CATEGORIES.map((cat) => {
            const count = categoryCounts[cat.id] ?? 0;
            if (count === 0 && cat.id !== 'all') return null; // Honest: hide empty categories
            const isActive = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                aria-pressed={isActive}
                className={glass.segBtn}
                type="button"
              >
                {cat.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* SECTION 3: Curated Editorial Grid */}
      {!loading && remainingTasks.length > 0 && (
        <div className={glass.grid}>
          {remainingTasks.map((task) => {
            const identity = FAMILY_TONES[getCanonicalFamily(task)];
            return (
            <article
              key={task.id}
              className={glass.card}
              data-tone={identity.tone}
            >
              <div className={glass.cardHead}>
                <Glyph tone={identity.tone} icon={identity.icon} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className={glass.cardMeta}>
                    <span className={`${glass.label} ${glass.labelInk}`}>{getCategoryLabel(task.category)}</span>
                    <span className={glass.chip}>{task.targetWordCountMin}–{task.targetWordCountMax} từ</span>
                  </div>
                  <h3 className={glass.cardTitle}>{task.title}</h3>
                  <span className="block text-xs text-on-surface-variant">
                    Độc giả hướng tới: {task.audience || 'Độc giả chung'}
                  </span>
                </div>
              </div>

              <blockquote className={`${glass.promptQuote} line-clamp-3`} lang="en">
                “{task.prompt}”
              </blockquote>

              <div className={glass.cardFoot}>
                <span className={glass.cardCount}>
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">edit_note</span> Phòng viết có hướng dẫn
                </span>
                <button
                  disabled={creating}
                  onClick={() => onSelectTask(task)}
                  data-guide="wc-start"
                  className={`${glass.btn} ${glass.btnSm} ${glass.btnSoft}`}
                  type="button"
                  aria-label={`Bắt đầu viết: ${task.title}`}
                >
                  <span>Bắt đầu viết</span>
                  <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </article>
            );
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && filteredTasks.length === 0 && (
        <StatePanel
          icon={<span className="material-symbols-outlined text-[28px]">menu_book</span>}
          title="Không có đề bài nào trong chủ đề này"
          text={selectedCategory === 'all'
            ? 'Chưa có đề bài viết nào được tìm thấy trong danh mục.'
            : `Không tìm thấy đề bài nào thuộc "${selectedCategory}". Hãy chuyển sang chủ đề khác để xem các đề bài có sẵn.`}
          actions={selectedCategory !== 'all' ? (
            <button
              onClick={() => setSelectedCategory('all')}
              className={`${glass.btn} ${glass.btnPrimary}`}
            >
              Xem tất cả đề bài
            </button>
          ) : undefined}
        />
      )}

    </div>
  );
};

