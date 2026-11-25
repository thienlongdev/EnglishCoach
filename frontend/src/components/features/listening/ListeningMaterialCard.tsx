import React from 'react';
import Link from 'next/link';
import { Clock, FileText, Play, Subtitles, Trash2 } from 'lucide-react';
import { ListeningMaterialSummary } from '../../../types/listening';
import { useLanguage } from '@/context/LanguageContext';
import { glass as s, MediaPicture, VOICE_LABEL, categoryLabel, formatClock, youtubeThumb } from './glass/ListeningGlass';

interface ListeningMaterialCardProps {
    material: ListeningMaterialSummary;
    onDelete?: (id: number) => void;
}

/**
 * A learner's own material ("Bài nghe của tôi"). A YouTube import shows its own thumbnail; a document / text import has no
 * picture, so it gets a typographic audio cover — never a video thumbnail, never an invented CEFR or accent.
 */
export const ListeningMaterialCard: React.FC<ListeningMaterialCardProps> = ({ material, onDelete }) => {
    const { locale, t } = useLanguage();
    const vi = locale === 'vi';
    const isDocument = material.sourceType === 'DOCUMENT';
    const thumbnailUrl = isDocument ? null : (material.thumbnail || youtubeThumb(material.youtubeVideoId, material.audioUrl));
    const duration = formatClock(material.durationSeconds);
    // A personal import is stored only with its transcript segments (AGENTS §18, document jobs): the summary DTO carries no
    // flag, so an absent value means "has a transcript"; an explicit false from the server still wins.
    const hasTranscript = material.hasTranscript ?? material.practiceAvailable ?? true;

    const handleDelete = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (onDelete) {
            onDelete(material.id);
        }
    };

    return (
        <article className={`${s.panel} ${s.mediaCard}`} data-tone={isDocument ? 'talks' : 'science'}>
            <div className={s.thumb}>
                <MediaPicture
                    src={thumbnailUrl}
                    alt=""
                    label={isDocument ? (vi ? 'Âm thanh từ tài liệu' : 'Document audio') : (material.channel || 'YouTube')}
                    title={material.title}
                    tone={isDocument ? 'document' : 'youtube'}
                />
                <div className={s.thumbTop}>
                    <div className={s.thumbBadges}>
                        {isDocument
                            ? <span className={s.pill} data-kind="document"><FileText size={11} aria-hidden="true" />{vi ? 'Tài liệu / Văn bản' : 'Document / Text'}</span>
                            : <span className={s.pill} data-kind="youtube">YouTube</span>}
                        {!isDocument && material.cefrLevel && <span className={s.pill} data-kind="level">{material.cefrLevel}</span>}
                        {!isDocument && material.speakerCount ? <span className={s.pill}>{material.speakerCount === 1 ? 'Monologue' : 'Dialogue'}</span> : null}
                    </div>
                    {onDelete && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            title={vi ? "Xóa tài liệu" : "Delete material"}
                            aria-label={`${vi ? 'Xóa' : 'Delete'}: ${material.title}`}
                            className={s.cardDelete}
                        >
                            <Trash2 size={15} />
                        </button>
                    )}
                </div>
                {!isDocument && <span className={s.thumbPlay} aria-hidden="true"><Play size={20} className="ml-0.5 fill-current" /></span>}
                {duration && <span className={s.duration}><Clock size={11} aria-hidden="true" />{duration}</span>}
            </div>

            <div className={s.cardBody}>
                <div className={s.cardKicker}>
                    {isDocument
                        ? (material.voiceId && VOICE_LABEL[material.voiceId] ? <b>{vi ? VOICE_LABEL[material.voiceId] : material.voiceId}</b> : null)
                        : (material.accent ? <b>{material.accent}</b> : null)}
                    {material.topic && <><span className={s.dot} aria-hidden="true" /><span>{categoryLabel(material.topic, vi)}</span></>}
                </div>
                <h3 className={s.cardTitle}>
                    <Link href={`/listening/${material.id}`} className={s.cardLink}>{material.title}</Link>
                </h3>
                <div className={s.cardFoot}>
                    <span className={s.avail} data-on={Boolean(hasTranscript)}>
                        <Subtitles size={15} aria-hidden="true" />
                        {hasTranscript ? (vi ? 'Transcript đồng bộ' : 'Synced transcript') : (vi ? 'Chưa có transcript' : 'No transcript')}
                    </span>
                    <span className={s.cardCta} aria-hidden="true"><Play size={13} className="fill-current" />{t.practiceNow || (vi ? 'Luyện ngay' : 'Practice Now')}</span>
                </div>
            </div>
        </article>
    );
};
