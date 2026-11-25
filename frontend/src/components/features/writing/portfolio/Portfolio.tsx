'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  PortfolioSummaryItem,
  LongitudinalProgress,
  SkillDimensionScore,
  WritingSessionDetail
} from '@/types/writing';
import { writingApi } from '@/services/writingApi';
import {
  getDimensionLabel,
  getTrendLabel,
  getCategoryLabel,
  getStageLabel
} from '@/lib/writing/labels';
import { FolderOpen, FileCheck2, RefreshCcw, PenLine, Search } from 'lucide-react';
import { WritingHero, StudioLoading, StatePanel, glass } from '../glass/WritingGlass';

interface PortfolioProps {
  onOpenSession: (sessionId: string) => void;
  onNavigateToCoach?: () => void;
}

export const Portfolio: React.FC<PortfolioProps> = ({ onOpenSession, onNavigateToCoach }) => {
  const [activeTab, setActiveTab] = useState<'works' | 'analytics'>('works');
  const [items, setItems] = useState<PortfolioSummaryItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'in-progress' | 'completed' | 'favorites'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

  // Longitudinal state
  const [longitudinalData, setLongitudinalData] = useState<LongitudinalProgress | null>(null);
  const [skillScores, setSkillScores] = useState<SkillDimensionScore[]>([]);
  const [loadingAnalytics, setLoadingAnalytics] = useState<boolean>(false);

  // Detail inspection state
  const [inspectingSessionId, setInspectingSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<WritingSessionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false);

  const loadPortfolio = async () => {
    setLoading(true);
    try {
      const stateParam = filter === 'all' || filter === 'favorites' ? undefined : filter;
      const favoriteParam = filter === 'favorites' ? true : undefined;
      const data = await writingApi.getPortfolio(stateParam, favoriteParam);
      setItems(data);
    } catch (err) {
      console.error('Failed to load portfolio sessions', err);
    } finally {
      setLoading(false);
    }
  };

  const loadAnalytics = async () => {
    setLoadingAnalytics(true);
    try {
      const [long, skills] = await Promise.all([
        writingApi.getLongitudinalProgress(),
        writingApi.getSkillDimensionScores()
      ]);
      setLongitudinalData(long);
      setSkillScores(skills);
    } catch (err) {
      console.error('Failed to load longitudinal analytics', err);
    } finally {
      setLoadingAnalytics(false);
    }
  };

  useEffect(() => {
    loadPortfolio();
    loadAnalytics();
  }, [filter]);

  useEffect(() => {
    if (activeTab === 'analytics') {
      loadAnalytics();
    }
  }, [activeTab]);

  const handleOpenDetail = async (sessionId: string) => {
    if (inspectingSessionId === sessionId) {
      setInspectingSessionId(null);
      setSessionDetail(null);
      return;
    }
    setInspectingSessionId(sessionId);
    setLoadingDetail(true);
    try {
      const detail = await writingApi.getSessionDetail(sessionId);
      setSessionDetail(detail);
    } catch (err) {
      console.error('Failed to load session detail', err);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Bạn có chắc chắn muốn xóa bài viết này không?')) return;
    try {
      await writingApi.deleteSession(id);
      setItems((prev) => prev.filter((s) => s.sessionId !== id));
    } catch (err) {
      console.error('Failed to delete session', err);
    }
  };

  const handleToggleFavorite = async (e: React.MouseEvent, item: PortfolioSummaryItem) => {
    e.stopPropagation();
    const newFav = !item.isFavorite;
    try {
      await writingApi.setFavorite(item.sessionId, newFav);
      setItems((prev) =>
        prev.map((s) => (s.sessionId === item.sessionId ? { ...s, isFavorite: newFav } : s))
      );
    } catch (err) {
      console.error('Failed to toggle favorite', err);
    }
  };

  // Filter items by client search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.taskTitle.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        (item.previewText && item.previewText.toLowerCase().includes(q))
    );
  }, [items, searchQuery]);

  // Aggregate stats from real portfolio
  const stats = useMemo(() => {
    const completedCount = items.filter((i) => i.stage === 'COMPLETED').length;
    const totalWords = items.reduce((sum, i) => sum + (i.wordCount || 0), 0);
    const totalDrafts = items.reduce((sum, i) => sum + (i.draftCount || 1), 0);
    const favCount = items.filter((i) => i.isFavorite).length;
    return { completedCount, totalWords, totalDrafts, favCount };
  }, [items]);

  const leadItem = filteredItems[0];
  const secondaryItems = filteredItems.slice(1);

  return (
    <div className={`${glass.stack} w-full pb-6`}>
      {/* Secondary Sub-Navigation Toolbar */}
      <div className={`${glass.panel} ${glass.toolbar}`}>
        <div className={glass.seg} role="tablist" aria-label="Hồ sơ bài viết">
          <button
            onClick={() => setActiveTab('works')}
            role="tab"
            aria-selected={activeTab === 'works'}
            className={glass.segBtn}
            type="button"
          >
            <span className="material-symbols-outlined text-[16px]">auto_stories</span>
            <span>Hành trình bài viết</span>
          </button>

          <button
            onClick={() => setActiveTab('analytics')}
            role="tab"
            aria-selected={activeTab === 'analytics'}
            className={glass.segBtn}
            type="button"
          >
            <span className="material-symbols-outlined text-[16px]">insights</span>
            <span>Phân tích tiến trình dài hạn</span>
          </button>
        </div>

        <div className="flex items-center gap-space-sm">
          <span className={`${glass.chip} hidden md:inline-flex`}>
            Bản thảo đã lưu: {items.length}
          </span>
          {onNavigateToCoach && (
            <button
              onClick={onNavigateToCoach}
              className={`${glass.btn} ${glass.btnPrimary}`}
              type="button"
            >
              <span className="material-symbols-outlined text-[16px]">add_circle</span>
              <span>Tạo bản thảo mới</span>
            </button>
          )}
        </div>
      </div>

      {activeTab === 'works' ? (
        <>
          <WritingHero
            world="portfolio"
            titleId="portfolio-hero-title"
            eyebrow="Hồ sơ bài viết · Lưu trữ cá nhân"
            eyebrowIcon={<FolderOpen aria-hidden="true" />}
            title="Hành trình"
            accent="bài viết"
            lead="Nhật ký lưu giữ quá trình lập luận, chỉnh sửa và hoàn thiện phong cách viết. Mỗi bản nháp là một bước tiến về tư duy diễn đạt."
            stats={loading ? [] : [
              { value: stats.completedCount, label: 'Bài hoàn chỉnh', icon: <FileCheck2 aria-hidden="true" /> },
              { value: stats.totalDrafts, label: 'Vòng chỉnh sửa', icon: <RefreshCcw aria-hidden="true" /> },
              { value: stats.totalWords.toLocaleString('vi-VN'), label: 'Từ đã viết', icon: <PenLine aria-hidden="true" /> },
            ]}
          />

          {/* Filter & Search Bar */}
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-space-md">
            <div className={`${glass.seg} w-fit`} role="group" aria-label="Lọc bài viết">
              {(['all', 'in-progress', 'completed', 'favorites'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  type="button"
                  aria-pressed={filter === f}
                  className={glass.segBtn}
                >
                  {f === 'all'
                    ? `Tất cả (${items.length})`
                    : f === 'in-progress'
                    ? 'Đang viết'
                    : f === 'completed'
                    ? `Đã hoàn thành (${stats.completedCount})`
                    : `Yêu thích (${stats.favCount})`}
                </button>
              ))}
            </div>

            <label className={`${glass.search} w-full md:w-80`}>
              <Search aria-hidden="true" />
              <span className="sr-only">Tìm kiếm bài viết</span>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm kiếm theo từ khóa, tiêu đề..."
                type="search"
                className={glass.searchInput}
              />
            </label>
          </div>

          {/* Content Stream */}
          {loading ? (
            <div className={glass.panel}>
              <StudioLoading text="Đang tải hồ sơ bài viết..." />
            </div>
          ) : filteredItems.length === 0 ? (
            <div className={`${glass.panel} ${glass.state}`}>
              <div className={glass.stateIcon} aria-hidden="true">
                <span className="material-symbols-outlined text-[28px]">folder_open</span>
              </div>
              <h4 className={glass.stateTitle}>
                Chưa có bản thảo bài viết nào
              </h4>
              <p className="font-body-sm text-body-sm text-on-surface-variant max-w-sm mx-auto">
                {filter === 'favorites'
                  ? 'Gắn dấu sao cho bài viết hoặc bản nháp để lưu vào mục yêu thích.'
                  : searchQuery
                  ? 'Không tìm thấy bài viết nào phù hợp với từ khóa tìm kiếm.'
                  : 'Bắt đầu một buổi luyện viết cùng Writing Coach để lưu lại tiến trình học.'}
              </p>
              {onNavigateToCoach && filter !== 'favorites' && (
                <div className="pt-2">
                  <button
                    onClick={onNavigateToCoach}
                    className={`${glass.btn} ${glass.btnPrimary}`}
                    type="button"
                  >
                    <span>Bắt đầu viết bài đầu tiên</span>
                    <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-space-xl">
              {/* Supporting Radar & 4-Dimension Snapshot Card */}
              <div className={`${glass.panel} p-5 sm:p-7`}>
                {(() => {
                  const canonicalDimensions = [
                    { key: 'TASK_FULFILLMENT', label: 'Đáp ứng yêu cầu' },
                    { key: 'COHERENCE_COHESION', label: 'Mạch lạc và Liên kết' },
                    { key: 'LEXICAL_RESOURCE', label: 'Vốn từ vựng' },
                    { key: 'GRAMMATICAL_RANGE_ACCURACY', label: 'Ngữ pháp chuẩn xác' }
                  ];
                  const validSkills = skillScores.filter((s) => s.score !== undefined && s.score !== null && s.score > 0);
                  const hasEnoughData = validSkills.length >= 1;

                  if (!hasEnoughData) {
                    return (
                      <div className="flex flex-col md:flex-row items-center justify-between gap-space-lg">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-on-surface-variant font-bold">
                              Cấu trúc ngôn ngữ
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-surface-container text-on-surface-variant font-label-stamp text-label-stamp uppercase">
                              Hồ sơ
                            </span>
                          </div>
                          <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                            Biểu đồ cân bằng diễn đạt (4 Tiêu chí)
                          </h3>
                          <p className="font-body-sm text-body-sm text-on-surface-variant">
                            Tiến trình đánh giá 4 tiêu chí chuẩn hóa qua các bài viết đã nộp và đánh giá.
                          </p>
                        </div>
                        <div className={`${glass.well} flex items-center gap-3 py-4 px-6 text-on-surface-variant`}>
                          <span className="material-symbols-outlined text-[28px] text-primary">radar</span>
                          <div className="text-xs">
                            <span className="font-semibold text-on-surface block">Chưa đủ dữ liệu biểu đồ</span>
                            <span>Hoàn thành ít nhất một bài viết để hệ thống hiển thị biểu đồ 4 tiêu chí.</span>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const radarPointsData = canonicalDimensions.map((dim) => {
                    const match = skillScores.find((s) => s.dimension === dim.key || s.name === dim.key);
                    const score = match && match.score != null ? match.score : null;
                    return { ...dim, score };
                  });

                  const count = radarPointsData.length;
                  const center = 140;
                  const maxR = 65;
                  const points = radarPointsData.map((d, idx) => {
                    const angle = (2 * Math.PI / count) * idx - Math.PI / 2;
                    const r = ((d.score || 0) / 100) * maxR;
                    const x = center + r * Math.cos(angle);
                    const y = center + r * Math.sin(angle);
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  }).join(' ');

                  const axisEndpoints = radarPointsData.map((_, idx) => {
                    const angle = (2 * Math.PI / count) * idx - Math.PI / 2;
                    const x = center + maxR * Math.cos(angle);
                    const y = center + maxR * Math.sin(angle);
                    return { x, y };
                  });

                  return (
                    <div className="flex flex-col lg:flex-row items-center justify-between gap-space-xl">
                      <div className="space-y-2 max-w-xl">
                        <div className="flex items-center gap-2">
                          <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-primary font-bold">
                            Cấu trúc ngôn ngữ
                          </span>
                          <span className="px-2 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed font-label-stamp text-label-stamp uppercase">
                            Ảnh chụp 4 chiều
                          </span>
                        </div>
                        <h3 className="font-headline-sm text-headline-sm text-on-surface font-semibold">
                          Biểu đồ cân bằng diễn đạt (4 Tiêu chí chuẩn hóa)
                        </h3>
                        <p className="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
                          Tổng hợp năng lực từ các bài viết đã hoàn tất: Task Fulfillment, Coherence and Cohesion, Lexical Resource, và Grammatical Range và Accuracy.
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-outline font-label-stamp text-label-stamp uppercase">
                          {radarPointsData.map((d) => (
                            <div key={d.key} className={`${glass.metric} flex flex-col gap-1.5 normal-case tracking-normal`}>
                              <span className="text-on-surface-variant text-[11px] font-semibold truncate">{d.label}</span>
                              <span className="text-on-surface font-bold text-lg leading-none tabular-nums">{d.score != null ? `${d.score}%` : '—'}</span>
                              <span className={glass.meter} aria-hidden="true"><i style={{ ['--p' as string]: `${d.score ?? 0}%` }} /></span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="relative w-full aspect-square max-w-[280px] shrink-0 flex items-center justify-center p-1">
                        <svg className="w-full h-full text-surface-variant overflow-visible" viewBox="0 0 280 280">
                          {/* Concentric Guide Circles */}
                          <circle cx="140" cy="140" r="65" fill="none" opacity="0.3" stroke="currentColor" strokeDasharray="3,3" strokeWidth="1" />
                          <circle cx="140" cy="140" r="42" fill="none" opacity="0.25" stroke="currentColor" strokeDasharray="3,3" strokeWidth="1" />
                          <circle cx="140" cy="140" r="20" fill="none" opacity="0.2" stroke="currentColor" strokeDasharray="3,3" strokeWidth="1" />

                          {/* 4 Axis Lines */}
                          {axisEndpoints.map((ep, idx) => (
                            <line key={idx} x1="140" y1="140" x2={ep.x} y2={ep.y} stroke="currentColor" strokeWidth="1" opacity="0.35" />
                          ))}

                          {/* Radar Polygons */}
                          <defs>
                            <linearGradient id="wp-radar-fill" x1="75" y1="75" x2="205" y2="205" gradientUnits="userSpaceOnUse">
                              <stop offset="0" style={{ stopColor: 'var(--w1)', stopOpacity: 0.45 }} />
                              <stop offset="1" style={{ stopColor: 'var(--w2)', stopOpacity: 0.3 }} />
                            </linearGradient>
                          </defs>
                          <polygon fill="url(#wp-radar-fill)" points={points} />
                          <polygon className="text-primary" fill="none" points={points} stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />

                          {/* Data dots */}
                          {radarPointsData.map((d, idx) => {
                            const angle = (2 * Math.PI / count) * idx - Math.PI / 2;
                            const r = ((d.score || 0) / 100) * maxR;
                            const x = center + r * Math.cos(angle);
                            const y = center + r * Math.sin(angle);
                            return <circle key={idx} cx={x} cy={y} r="4" className="text-primary" fill="currentColor" />;
                          })}

                          {/* 4 Visible Axis Labels with Dimension Names and Values */}
                          {/* Top: Task Fulfillment */}
                          <text x="140" y="24" textAnchor="middle" className="text-[11px] font-bold fill-on-surface">
                            Đáp ứng yêu cầu ({radarPointsData[0]?.score != null ? `${radarPointsData[0].score}%` : '—'})
                          </text>
                          <text x="140" y="38" textAnchor="middle" className="text-[9px] fill-on-surface-variant font-medium">
                            Task Fulfillment
                          </text>

                          {/* Right: Coherence & Cohesion */}
                          <text x="216" y="136" textAnchor="start" className="text-[11px] font-bold fill-on-surface">
                            Mạch lạc ({radarPointsData[1]?.score != null ? `${radarPointsData[1].score}%` : '—'})
                          </text>
                          <text x="216" y="149" textAnchor="start" className="text-[9px] fill-on-surface-variant font-medium">
                            Coherence
                          </text>

                          {/* Bottom: Lexical Resource */}
                          <text x="140" y="242" textAnchor="middle" className="text-[11px] font-bold fill-on-surface">
                            Vốn từ vựng ({radarPointsData[2]?.score != null ? `${radarPointsData[2].score}%` : '—'})
                          </text>
                          <text x="140" y="255" textAnchor="middle" className="text-[9px] fill-on-surface-variant font-medium">
                            Lexical Resource
                          </text>

                          {/* Left: Grammatical Range & Accuracy */}
                          <text x="64" y="136" textAnchor="end" className="text-[11px] font-bold fill-on-surface">
                            Ngữ pháp ({radarPointsData[3]?.score != null ? `${radarPointsData[3].score}%` : '—'})
                          </text>
                          <text x="64" y="149" textAnchor="end" className="text-[9px] fill-on-surface-variant font-medium">
                            Grammar and Accuracy
                          </text>
                        </svg>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* ONE Coherent "Lịch sử bài viết" Container */}
              <div className={`${glass.panel} p-5 sm:p-7 space-y-4`}>
                <div className="flex items-center justify-between pb-3 border-b border-outline-variant/40">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[22px]">history_edu</span>
                    <h2 className="font-headline-sm text-headline-sm font-bold text-on-surface">
                      Lịch sử bài viết
                    </h2>
                    <span className={glass.chip}>
                      {filteredItems.length}
                    </span>
                  </div>
                  <span className="font-label-stamp text-[11px] text-on-surface-variant uppercase hidden sm:inline">
                    Mỗi bài viết hiển thị một lần duy nhất
                  </span>
                </div>

                <div className="flex flex-col gap-3">
                  {filteredItems.map((item) => {
                    const isInspecting = inspectingSessionId === item.sessionId;
                    return (
                      <div key={item.sessionId}>
                        <div
                          onClick={() => handleOpenDetail(item.sessionId)}
                          className={glass.draftRow}
                          data-open={isInspecting}
                          data-stage={item.stage === 'COMPLETED' ? 'done' : 'open'}
                        >
                          <span className={glass.draftSpine} aria-hidden="true" />
                          <div className="flex-1 space-y-1.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-label-stamp text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-primary/10 text-primary">
                                {getCategoryLabel(item.category)}
                              </span>
                              <span
                                className={`font-label-stamp text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                                  item.stage === 'COMPLETED'
                                    ? 'bg-tertiary-fixed/30 text-tertiary'
                                    : 'bg-secondary-fixed/30 text-on-secondary-fixed'
                                }`}
                              >
                                {item.stage === 'COMPLETED' ? 'Đã hoàn tất' : `Đang viết (${getStageLabel(item.stage).title})`}
                              </span>
                              {item.score !== undefined && item.score !== null && (
                                <span className="font-label-stamp text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                  Điểm: {item.score}/100
                                </span>
                              )}
                              <span className="text-xs text-on-surface-variant font-medium">
                                • {item.draftCount || 1} bản nháp
                              </span>
                              <span className="text-xs text-on-surface-variant font-medium">
                                • {item.wordCount} từ
                              </span>
                            </div>

                            <h3 className="font-headline-sm text-base font-semibold text-on-surface hover:text-primary transition-colors">
                              {item.taskTitle}
                            </h3>

                            {item.previewText && !isInspecting && (
                              <p className="font-body-sm text-xs text-on-surface-variant line-clamp-1 italic">
                                &ldquo;{item.previewText}&rdquo;
                              </p>
                            )}

                            <div className="text-[11px] text-on-surface-variant">
                              Cập nhật lần cuối: {new Date(item.updatedAt).toLocaleDateString('vi-VN')}
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center justify-end gap-2 self-end md:self-center">
                            <button
                              onClick={(e) => handleToggleFavorite(e, item)}
                              title={item.isFavorite ? 'Bỏ đánh dấu yêu thích' : 'Đánh dấu yêu thích'}
                              aria-label={item.isFavorite ? 'Bỏ đánh dấu yêu thích' : 'Đánh dấu yêu thích'}
                              aria-pressed={!!item.isFavorite}
                              className={glass.iconBtn}
                              style={item.isFavorite ? { color: '#f59e0b' } : undefined}
                              type="button"
                            >
                              <span className="material-symbols-outlined text-[18px]">
                                {item.isFavorite ? 'star' : 'star_border'}
                              </span>
                            </button>

                            <button
                              onClick={(e) => handleDelete(e, item.sessionId)}
                              title="Xóa phiên viết"
                              aria-label="Xóa phiên viết"
                              className={glass.iconBtn}
                              type="button"
                            >
                              <span className="material-symbols-outlined text-[18px]">delete</span>
                            </button>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenDetail(item.sessionId);
                              }}
                              aria-expanded={isInspecting}
                              className={`${glass.btn} ${glass.btnSm} ${glass.btnSoft}`}
                            >
                              <span>{isInspecting ? 'Thu gọn' : 'Xem chi tiết'}</span>
                              <span className="material-symbols-outlined text-[14px]">
                                {isInspecting ? 'expand_less' : 'expand_more'}
                              </span>
                            </button>

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenSession(item.sessionId);
                              }}
                              className={`${glass.btn} ${glass.btnSm} ${glass.btnPrimary}`}
                            >
                              <span>Mở trong Coach</span>
                              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                            </button>
                          </div>
                        </div>

                        {/* Expanded Session Detail Panel */}
                        {isInspecting && (
                          <div className={`${glass.panel} ${glass.panelLow} mt-3 p-5 space-y-5 animate-in fade-in duration-150`}>
                            {loadingDetail ? (
                              <StudioLoading text="Đang tải chi tiết bài viết..." />
                            ) : sessionDetail ? (
                              <div className="space-y-5">
                                {/* Task Prompt & Metadata */}
                                {sessionDetail.task && (
                                  <div className="p-4 rounded-xl bg-surface-container-lowest border border-surface-variant/30 space-y-2">
                                    <div className="flex items-center justify-between">
                                      <span className="font-label-stamp text-[10px] uppercase font-bold text-primary">
                                        Đề bài và Yêu cầu
                                      </span>
                                      <span className="font-label-stamp text-[10px] uppercase text-on-surface-variant">
                                        Mục tiêu: {sessionDetail.task.targetWordCountMin || 150} - {sessionDetail.task.targetWordCountMax || 250} từ
                                      </span>
                                    </div>
                                    <p className="font-body-md text-sm text-on-surface font-medium leading-relaxed">
                                      {sessionDetail.task.prompt}
                                    </p>
                                  </div>
                                )}

                                {/* Nested Drafts History */}
                                <div className="space-y-2">
                                  <h4 className="font-headline-sm text-xs font-bold uppercase tracking-wider text-on-surface flex items-center gap-1.5">
                                    <span className="material-symbols-outlined text-[16px] text-secondary">history</span>
                                    Lịch sử các bản nháp ({sessionDetail.drafts?.length || 0})
                                  </h4>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {sessionDetail.drafts?.map((draft, dIdx) => {
                                      const isFinal =
                                        dIdx === sessionDetail.drafts.length - 1 &&
                                        sessionDetail.session.stage === 'COMPLETED';
                                      return (
                                        <div
                                          key={draft.id}
                                          className="p-3.5 rounded-xl bg-surface-container-lowest border border-surface-variant/30 space-y-2"
                                        >
                                          <div className="flex items-center justify-between">
                                            <span className="font-label-stamp text-[11px] font-bold text-on-surface">
                                              {isFinal ? 'Bản hoàn thiện (Final)' : `Bản nháp #${draft.ordinal || dIdx + 1}`}
                                            </span>
                                            <div className="flex items-center gap-2">
                                              <span className="text-[11px] text-on-surface-variant">
                                                {draft.wordCount} từ
                                              </span>
                                              {draft.overallScore != null && (
                                                <span className="font-label-stamp text-[10px] px-1.5 py-0.5 rounded bg-tertiary-fixed/30 text-tertiary font-bold">
                                                  {draft.overallScore}đ
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                          <p className="font-body-sm text-xs text-on-surface-variant line-clamp-3 italic">
                                            &ldquo;{draft.content}&rdquo;
                                          </p>
                                          <div className="text-[10px] text-outline">
                                            Tạo lúc: {new Date(draft.createdAt).toLocaleString('vi-VN')}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>

                                {/* Persisted Assessment Details */}
                                {sessionDetail.finalAssessment && (
                                  <div className="space-y-4 pt-4 border-t border-surface-variant/30">
                                    <div className="flex items-center justify-between">
                                      <h4 className="font-headline-sm text-xs font-bold uppercase tracking-wider text-on-surface flex items-center gap-1.5">
                                        <span className="material-symbols-outlined text-[16px] text-tertiary">verified</span>
                                        Kết quả đánh giá 4 tiêu chí chuẩn hóa
                                      </h4>
                                      {sessionDetail.finalAssessment.overallScore != null && (
                                        <span className="font-headline-sm text-sm font-bold text-tertiary">
                                          Tổng điểm: {sessionDetail.finalAssessment.overallScore}/100
                                        </span>
                                      )}
                                    </div>

                                    {/* 4 Dimension Verdicts */}
                                    {sessionDetail.finalAssessment.dimensionVerdicts?.length > 0 && (
                                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                                        {sessionDetail.finalAssessment.dimensionVerdicts.map((v) => (
                                          <div
                                            key={v.dimension}
                                            className="p-3 rounded-xl bg-surface-container-lowest border border-surface-variant/30 space-y-1"
                                          >
                                            <div className="flex items-center justify-between">
                                              <span className="font-label-stamp text-[10px] uppercase font-bold text-on-surface">
                                                {getDimensionLabel(v.dimension)}
                                              </span>
                                              {v.score != null && (
                                                <span className="font-bold text-xs text-primary">{v.score}%</span>
                                              )}
                                            </div>
                                            <p className="text-[11px] text-on-surface-variant leading-relaxed line-clamp-2">
                                              {v.summary}
                                            </p>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Feedback Summary */}
                                    {sessionDetail.finalAssessment.coverageSummary && (
                                      <div className="p-3.5 rounded-xl bg-surface-container-lowest border border-surface-variant/30 space-y-1">
                                        <span className="font-label-stamp text-[10px] uppercase font-bold text-secondary">
                                          Nhận xét tổng thể từ AI
                                        </span>
                                        <p className="text-xs text-on-surface leading-relaxed">
                                          {sessionDetail.finalAssessment.coverageSummary}
                                        </p>
                                      </div>
                                    )}

                                    {/* Detected Issues */}
                                    {(() => {
                                      const detectedIssues = sessionDetail.finalAssessment.issues || sessionDetail.finalAssessment.allIssues || [];
                                      if (detectedIssues.length === 0) return null;
                                      return (
                                        <div className="space-y-2">
                                          <span className="font-label-stamp text-[10px] uppercase font-bold text-error">
                                            Điểm ngữ pháp & Diễn đạt cần lưu ý ({detectedIssues.length})
                                          </span>
                                          <div className="space-y-2">
                                            {detectedIssues.map((iss, iIdx) => (
                                              <div
                                                key={iss.id || iIdx}
                                                className="p-3 rounded-xl bg-surface-container-lowest border border-error/20 space-y-1.5"
                                              >
                                                <div className="flex items-center justify-between gap-2">
                                                  <span className="font-label-stamp text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-rose-50 text-error">
                                                    {getCategoryLabel(iss.category) || 'Ngữ pháp'}
                                                  </span>
                                                  {iss.sourceQuote && (
                                                    <span className="text-xs font-mono text-error font-semibold underline decoration-wavy">
                                                      &ldquo;{iss.sourceQuote}&rdquo;
                                                    </span>
                                                  )}
                                                </div>
                                                <p className="text-xs text-on-surface leading-relaxed">
                                                  <strong>Lý do:</strong> {iss.explanation}
                                                </p>
                                                {iss.teachingRule && (
                                                  <p className="text-xs text-on-surface-variant leading-relaxed">
                                                    <strong>Quy tắc:</strong> {iss.teachingRule}
                                                  </p>
                                                )}
                                                {iss.replacement && (
                                                  <p className="text-xs text-tertiary font-semibold leading-relaxed">
                                                    <strong>Sửa thành:</strong> {iss.replacement}
                                                  </p>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      );
                                    })()}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="text-center py-4 text-xs text-on-surface-variant">
                                Không tìm thấy thông tin chi tiết của bài viết này.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-space-2xl">
          {loadingAnalytics ? (
            <div className={glass.panel}>
              <StudioLoading text="Đang tính toán phân tích tiến trình..." />
            </div>
          ) : longitudinalData && (longitudinalData.completedSessionsCount > 0 || longitudinalData.totalWordsCumulative > 0) ? (
            <>
              {/* 1. Editorial Page Header */}
              <div className={`${glass.panel} ${glass.spotlight}`}>
                <div className="relative z-10 flex flex-col lg:flex-row lg:items-end justify-between gap-space-xl">
                  <div className="space-y-space-sm max-w-3xl">
                    <div className="flex items-center gap-space-sm flex-wrap">
                      <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-primary font-bold">
                        Nhìn lại hành trình
                      </span>
                      <span className="w-1.5 h-1.5 rounded-full bg-outline-variant"></span>
                      <span className="font-label-stamp text-label-stamp uppercase tracking-wider text-outline">
                        {longitudinalData.completedSessionsCount} bài viết đã đánh giá
                      </span>
                    </div>
                    <h2 className={glass.spotTitle}>
                      Biểu đồ tiến trình và Sự phát triển kỹ năng viết
                    </h2>
                    <p className="font-body-xl-editorial text-body-xl-editorial text-on-surface-variant leading-relaxed">
                      Phân tích đối chiếu qua từng bài viết. Ghi nhận quá trình cải thiện hành văn học thuật, khắc phục các lỗi diễn đạt và định hình phong cách viết tự nhiên.
                    </p>
                  </div>

                  {/* Benchmark Badge */}
                  <div className={`${glass.well} p-4 flex items-center gap-4 shrink-0`}>
                    <div className={glass.stateIcon} aria-hidden="true">
                      <span className="material-symbols-outlined text-[26px]">draw</span>
                    </div>
                    <div className="flex flex-col">
                      <span className={glass.label}>Tổng số từ đã viết</span>
                      <span className="text-2xl text-on-surface font-bold tabular-nums">
                        {longitudinalData.totalWordsCumulative.toLocaleString('vi-VN')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. Direct Comparative Diptych (Centerpiece) */}
              <div className={`${glass.panel} p-5 sm:p-8`}>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-space-sm mb-space-xl">
                  <div>
                    <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-secondary font-bold flex items-center gap-1">
                      <span className="material-symbols-outlined text-[18px]">swap_horiz</span>
                      Đối chiếu trước và sau
                    </span>
                    <h2 className="font-headline-lg text-headline-lg text-on-surface font-bold">
                      Sự thay đổi rõ nét trong cách hành văn
                    </h2>
                  </div>
                  <span className={glass.chip}>
                    Từ bài viết của bạn
                  </span>
                </div>

                {(() => {
                  const revisedItem = items.find((i) => (i.draftCount || 1) >= 2 && (i.firstDraftPreview || i.finalDraftPreview || i.previewText));
                  if (!revisedItem) {
                    return (
                      <div className="flex flex-col items-center justify-center py-12 px-4 text-center rounded-xl bg-surface-container-low/50 border border-surface-variant/30 gap-3">
                        <span className="material-symbols-outlined text-[40px] text-on-surface-variant/50">
                          compare_arrows
                        </span>
                        <div className="font-headline-sm text-base font-semibold text-on-surface">
                          Chưa có dữ liệu đối chiếu trước và sau
                        </div>
                        <p className="font-body-sm text-sm text-on-surface-variant max-w-md">
                          Hoàn thành bài viết có từ 2 bản thảo trở lên để hệ thống tự động đối chiếu bản thảo khởi đầu và bản thảo nâng cấp hoàn thiện.
                        </p>
                      </div>
                    );
                  }

                  const firstDraftText = revisedItem.firstDraftPreview || revisedItem.previewText || 'Bản thảo ban đầu đang được xử lý.';
                  const finalDraftText = revisedItem.finalDraftPreview || revisedItem.previewText || 'Bản sửa đổi hoàn thiện đang được xử lý.';
                  const resolvedErrors = (revisedItem.firstDraftIssueCount != null && revisedItem.finalDraftIssueCount != null && revisedItem.firstDraftIssueCount > revisedItem.finalDraftIssueCount)
                    ? revisedItem.firstDraftIssueCount - revisedItem.finalDraftIssueCount
                    : null;

                  return (
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-lg items-stretch relative">
                      {/* Left Side: Baseline */}
                      <div className="lg:col-span-5 flex flex-col justify-between bg-surface-container-low rounded-xl p-space-lg relative overflow-hidden border border-surface-variant/30">
                        <div className="space-y-space-md">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-space-xs">
                              <span className="w-2.5 h-2.5 rounded-full bg-outline"></span>
                              <span className="font-label-md text-label-md text-on-surface font-semibold truncate max-w-[200px]">
                                {revisedItem.taskTitle}
                              </span>
                            </div>
                            <span className="font-label-stamp text-label-stamp uppercase px-2 py-0.5 rounded bg-surface-container text-on-surface-variant font-bold">
                              Bản nháp 1 (Khởi đầu)
                            </span>
                          </div>
                          <div className="p-space-md rounded-xl bg-surface/70 space-y-space-2xs">
                            <span className="font-label-stamp text-label-stamp uppercase text-outline">
                              Trích đoạn bản thảo ban đầu
                            </span>
                            <p className="font-body-md text-body-md text-on-surface-variant italic leading-relaxed line-clamp-4">
                              “{firstDraftText}”
                            </p>
                          </div>
                        </div>
                        <div className="mt-space-lg pt-space-md space-y-space-xs border-t border-surface-variant/20">
                          <span className="font-label-stamp text-label-stamp uppercase tracking-wider text-secondary font-bold block">
                            Dữ liệu bản nháp 1
                          </span>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant">
                            {revisedItem.firstDraftWordCount ? <span>Độ dài: <strong>{revisedItem.firstDraftWordCount} từ</strong></span> : null}
                            {revisedItem.firstDraftIssueCount != null ? <span>Lỗi phát hiện: <strong>{revisedItem.firstDraftIssueCount} lỗi</strong></span> : null}
                            {revisedItem.firstDraftScore != null ? <span>Điểm số: <strong>{revisedItem.firstDraftScore}/100</strong></span> : null}
                          </div>
                        </div>
                      </div>

                      {/* Center Catalyst Arrow */}
                      <div className="lg:col-span-2 flex lg:flex-col items-center justify-center py-space-sm lg:py-0">
                        <div className="flex flex-col items-center gap-space-xs">
                          <div className="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-md">
                            <span className="material-symbols-outlined text-[24px]">trending_flat</span>
                          </div>
                          <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-secondary font-bold text-center">
                            {revisedItem.draftCount} lượt chỉnh sửa
                          </span>
                          {resolvedErrors !== null && (
                            <span className="text-[11px] font-semibold text-tertiary text-center">
                              Khắc phục {resolvedErrors} lỗi
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right Side: Revised Standard */}
                      <div className="lg:col-span-5 flex flex-col justify-between bg-surface rounded-xl p-space-lg shadow-xs relative overflow-hidden border border-surface-variant/30">
                        <div className="space-y-space-md">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-space-xs">
                              <span className="w-2.5 h-2.5 rounded-full bg-tertiary-container animate-pulse"></span>
                              <span className="font-label-md text-label-md text-primary font-bold">
                                Bản sửa đổi hoàn thiện
                              </span>
                            </div>
                            <span className="inline-flex items-center font-label-stamp text-label-stamp uppercase px-2.5 py-1 rounded-md bg-tertiary-container text-on-tertiary font-bold shadow-2xs">
                              Bản nháp #{revisedItem.draftCount}
                            </span>
                          </div>
                          <div className="p-space-md rounded-xl bg-surface-container-low/60 space-y-space-2xs">
                            <span className="font-label-stamp text-label-stamp uppercase text-primary font-bold">
                              Trích đoạn bản hoàn thiện
                            </span>
                            <p className="font-body-md text-body-md text-on-surface leading-relaxed line-clamp-4">
                              “{finalDraftText}”
                            </p>
                          </div>
                        </div>
                        <div className="mt-space-lg pt-space-md space-y-space-xs border-t border-surface-variant/20">
                          <span className="font-label-stamp text-label-stamp uppercase tracking-wider text-tertiary font-bold block">
                            Dữ liệu bản hoàn thiện
                          </span>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface">
                            <span>Độ dài: <strong>{revisedItem.finalDraftWordCount || revisedItem.wordCount} từ</strong></span>
                            {revisedItem.finalDraftIssueCount != null ? <span>Lỗi còn lại: <strong>{revisedItem.finalDraftIssueCount} lỗi</strong></span> : null}
                            {(revisedItem.finalDraftScore || revisedItem.score) != null ? <span>Điểm số: <strong>{revisedItem.finalDraftScore || revisedItem.score}/100</strong></span> : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* 3. 5-Dimension Skill Modeling */}
              {skillScores.length > 0 && (
                <div className="space-y-space-md">
                  <div>
                    <span className="font-label-stamp text-label-stamp uppercase tracking-widest text-primary font-bold block">
                      Ma trận năng lực
                    </span>
                    <h3 className="font-headline-lg text-headline-lg text-on-surface font-bold">
                      Các khía cạnh kỹ năng viết
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-lg">
                    {skillScores.map((dim) => {
                      const trendInfo = getTrendLabel(dim.trend);
                      return (
                        <div
                          key={dim.dimension}
                          className="p-space-lg rounded-xl border border-surface-variant/30 bg-surface-container-lowest shadow-xs space-y-space-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-label-md text-label-md font-bold uppercase tracking-wider text-primary">
                              {getDimensionLabel(dim.name || dim.dimension)}
                            </span>
                            <span
                              className={`font-label-stamp text-label-stamp uppercase px-2 py-0.5 rounded-full font-bold ${trendInfo.colorClass}`}
                            >
                              {trendInfo.label}
                            </span>
                          </div>

                          <div className="flex items-baseline gap-2">
                            <span className="font-display-hero text-[32px] font-bold text-on-surface">
                              {dim.score !== undefined && dim.score !== null ? dim.score : '—'}
                            </span>
                            {dim.score !== undefined && dim.score !== null && (
                              <span className="font-label-sm text-label-sm text-outline">/100</span>
                            )}
                            <span className="font-label-sm text-label-sm text-outline ml-auto">
                              {dim.evidenceCount} dữ liệu
                            </span>
                          </div>

                          <div className="w-full bg-surface-container h-1.5 rounded-full overflow-hidden">
                            <div
                              className="bg-primary h-full rounded-full"
                              style={{ width: `${dim.score || 0}%` }}
                            ></div>
                          </div>

                          <p className="font-body-sm text-body-sm text-on-surface-variant pt-space-xs border-t border-surface-variant/30">
                            {dim.guidance}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 4. Error Density History */}
              {longitudinalData.errorDensityHistory && longitudinalData.errorDensityHistory.length > 0 && (
                <div className={`${glass.panel} p-5 sm:p-6 space-y-space-sm`}>
                  <h4 className="text-lg text-on-surface font-bold flex items-center gap-2">
                    <span className="material-symbols-outlined text-[20px] text-primary">analytics</span>
                    <span>Mật độ lỗi theo thời gian (Số lỗi / 100 từ)</span>
                  </h4>
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    Chỉ số giảm dần phản ánh câu văn gãy gọn và chuẩn xác hơn qua từng bài viết.
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-sm pt-space-xs">
                    {longitudinalData.errorDensityHistory.map((ep, idx) => (
                      <div
                        key={idx}
                        className="p-space-sm rounded-lg bg-surface-container-low border border-surface-variant/30"
                      >
                        <span className="font-label-stamp text-label-stamp text-outline block font-semibold">
                          {ep.date}
                        </span>
                        <div className="font-headline-sm text-headline-sm text-primary font-bold mt-0.5">
                          {ep.errorsPerHundredWords.toFixed(1)}{' '}
                          <span className="font-label-stamp text-label-stamp font-normal text-on-surface-variant">
                            lỗi/100 từ
                          </span>
                        </div>
                        <span className="font-body-sm text-body-sm text-on-surface-variant block mt-1">
                          {ep.totalErrors} lỗi trên {ep.totalWords} từ
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className={`${glass.panel} ${glass.state}`}>
              <div className={glass.stateIcon} aria-hidden="true">
                <span className="material-symbols-outlined text-[28px]">insights</span>
              </div>
              <h4 className={glass.stateTitle}>
                Chưa đủ dữ liệu để phân tích tiến trình
              </h4>
              <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md mx-auto leading-relaxed">
                Hệ thống cần thêm lịch sử viết và chỉnh sửa để lập mô hình 5 chiều năng lực. Hãy hoàn thành bài viết đầu tiên hoặc kiểm tra câu để bắt đầu theo dõi tiến độ.
              </p>
              {onNavigateToCoach && (
                <div className="pt-2">
                  <button
                    onClick={onNavigateToCoach}
                    className={`${glass.btn} ${glass.btnPrimary}`}
                    type="button"
                  >
                    <span>Bắt đầu viết bài đầu tiên</span>
                    <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
