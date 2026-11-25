'use client';

import React from 'react';
import { PublicStimulusDto } from '@/types/exams';
import { stimulusDocuments } from '@/lib/exams/groupPresentation';
import { isImageAsset } from '@/lib/exams/media';
import { ExamAssetImage } from './ExamAssetImage';

interface StimulusRendererProps {
  stimulus?: PublicStimulusDto;
  stimuli?: PublicStimulusDto[];
  /** Needed to resolve image assets through playback grants (Exams Phase 4B.6). */
  attemptId?: string;
}

function toParagraphs(st: PublicStimulusDto): string[] {
  const body = st.bodyPayload || {};
  const rawContent = body.text || body.content || body.paragraphs || body.prompt || '';
  if (Array.isArray(rawContent)) {
    return rawContent.map((p: any) => String(p?.text ?? p ?? '').trim()).filter(Boolean);
  }
  if (typeof rawContent === 'string') {
    // If content starts with a markdown title matching st.title, strip it
    let text = rawContent.trim();
    if (st.title) {
      const escapedTitle = st.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const titlePattern = new RegExp(`^(#{1,4}\\s*)?${escapedTitle}\\s*\\n+`, 'i');
      text = text.replace(titlePattern, '').trim();
    } else {
      // If st.title was missing but text starts with # or ### Title, extract title
      const headerMatch = text.match(/^#{1,3}\s+([^\n]+)\n+/);
      if (headerMatch) {
        text = text.slice(headerMatch[0].length).trim();
      }
    }
    return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  }
  return [];
}

function Paragraph({ para }: { para: string }) {
  // If paragraph starts with "Paragraph A:" or "Paragraph B:", format the label cleanly
  const paraLabelMatch = para.match(/^(Paragraph\s+[A-Z]:?|\b[A-Z]\b:?)\s*(.*)/is);
  if (paraLabelMatch && paraLabelMatch[2]) {
    return (
      <p className="leading-relaxed text-[15px] sm:text-base text-foreground/90 font-normal select-text">
        <strong className="font-bold text-foreground mr-1.5">{paraLabelMatch[1]}</strong>
        {paraLabelMatch[2]}
      </p>
    );
  }
  return <p className="leading-relaxed text-[15px] sm:text-base text-foreground/90 font-normal select-text">{para}</p>;
}

export function StimulusRenderer({ stimulus, stimuli, attemptId }: StimulusRendererProps) {
  const items = stimuli && stimuli.length > 0 ? stimuli : stimulus ? [stimulus] : [];

  if (items.length === 0) return null;

  return (
    <div className="space-y-6">
      {items.map((st) => {
        const body = st.bodyPayload || {};
        const docs = stimulusDocuments(st.kind, body);
        const imageAssets = (st.assets || []).filter(isImageAsset);
        const grantImages = imageAssets.filter((a) => a.delivery === 'PLAYBACK_GRANT' && a.assetId);
        // Legacy payloads (no delivery hint) keep their historical static-path behaviour.
        const legacyImageUrl =
          grantImages.length > 0
            ? null
            : (st as any).attributes?.imageUrl ||
              body.imageUrl ||
              body.imageUri ||
              (body.svgAsset ? `/storage/exams/images/${body.svgAsset}` : null) ||
              (imageAssets[0] ? `/storage/exams/images/${imageAssets[0].assetId}.png` : null);
        const alt = body.altText || st.title || body.sceneDescription || 'Visual Stimulus';

        return (
          <div key={st.id} className="max-w-none space-y-4 text-foreground">
            {st.title && (
              <h3 className="text-xl font-bold tracking-tight text-foreground border-b border-border pb-2.5">
                {st.title}
              </h3>
            )}

            {docs.segmented ? (
              <div data-capability="MULTI_DOC_SEGMENTED" className="space-y-5">
                {docs.documents.map((doc, di) => (
                  <article
                    key={di}
                    aria-label={`Document ${di + 1}: ${doc.label}`}
                    className="rounded-xl border border-border bg-card p-5 shadow-xs space-y-3"
                  >
                    <header className="flex items-center gap-2 border-b border-border/70 pb-2">
                      <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] font-bold">
                        {di + 1}/{docs.documents.length}
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{doc.label}</span>
                    </header>
                    <div className="space-y-3 select-text">
                      {doc.paragraphs.map((para, idx) => (
                        <Paragraph key={idx} para={para} />
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="space-y-4 select-text">
                {String(st.kind || '').toUpperCase() === 'MULTI_DOC' && docs.declaredCount !== 1 && (
                  <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                    Văn bản gồm nhiều tài liệu; ranh giới tài liệu đang chờ duyệt. / Multiple documents; boundaries under review.
                  </p>
                )}
                {toParagraphs(st).map((para, idx) => (
                  <Paragraph key={idx} para={para} />
                ))}
              </div>
            )}

            {/* Visual assets resolved through playback grants (Charts, Maps, Diagrams, Photos) */}
            {grantImages.map((asset) => (
              <div key={asset.assetId} className="my-6 p-4 rounded-xl border border-border bg-card shadow-xs flex flex-col items-center">
                <ExamAssetImage attemptId={attemptId} asset={asset} alt={alt} />
              </div>
            ))}

            {legacyImageUrl && (
              <div className="my-6 p-4 rounded-xl border border-border bg-card shadow-xs flex flex-col items-center">
                <img
                  src={legacyImageUrl}
                  alt={alt}
                  className="w-full max-w-2xl h-auto max-h-[680px] object-contain rounded-lg border border-border/80 shadow-xs bg-white"
                  onError={(e) => {
                    const target = e.currentTarget;
                    const filename = target.src.split('/').pop();
                    if (filename && !target.src.includes('/storage/exams/images/')) {
                      target.src = `/storage/exams/images/${filename}`;
                    }
                  }}
                />
                <span className="text-xs text-muted-foreground mt-3 font-medium tracking-wide text-center">
                  {body.sceneDescription || st.title || 'Official Examination Visual Asset'}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
