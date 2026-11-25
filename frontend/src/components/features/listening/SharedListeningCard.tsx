"use client";

import React from 'react';
import Link from 'next/link';
import { Clock, Headphones, Play, Subtitles } from 'lucide-react';
import { ListeningLibraryItem } from '../../../types/listening';
import { glass as s, MediaPicture, categoryIdentity, categoryLabel, formatClock, youtubeThumb } from './glass/ListeningGlass';

interface SharedListeningCardProps {
    item: ListeningLibraryItem;
}

/** A SYSTEM lesson of Kho Listening: its own thumbnail, catalog values only, one primary control (the stretched title link). */
export const SharedListeningCard: React.FC<SharedListeningCardProps> = ({ item }) => {
    const thumbnailUrl = item.thumbnail || youtubeThumb(item.youtubeVideoId);
    const duration = formatClock(item.durationSeconds);
    const tone = categoryIdentity(item.topic).tone;
    const topicName = categoryLabel(item.topic, true);

    return (
        <article className={`${s.panel} ${s.mediaCard}`} data-tone={tone}>
            <div className={s.thumb}>
                <MediaPicture src={thumbnailUrl} alt="" label={item.channel || topicName || 'Listening'} title={item.title} tone={tone} />
                <div className={s.thumbTop}>
                    <div className={s.thumbBadges}>
                        {item.level && <span className={s.pill} data-kind="level">{item.level}</span>}
                        {item.accent && <span className={s.pill}>{item.accent}</span>}
                    </div>
                </div>
                <span className={s.thumbPlay} aria-hidden="true"><Play size={20} className="ml-0.5 fill-current" /></span>
                {duration && <span className={s.duration}><Clock size={11} aria-hidden="true" />{duration}</span>}
            </div>

            <div className={s.cardBody}>
                <div className={s.cardKicker}>
                    {item.channel && <b>{item.channel}</b>}
                    {item.channel && item.topic && <span className={s.dot} aria-hidden="true" />}
                    {item.topic && <span>{topicName}</span>}
                </div>
                <h3 className={s.cardTitle}>
                    <Link href={`/listening/${item.id}`} className={s.cardLink}>{item.title}</Link>
                </h3>
                <div className={s.cardFoot}>
                    <span className={s.avail} data-on={item.practiceAvailable}>
                        {item.practiceAvailable
                            ? <><Subtitles size={15} aria-hidden="true" />Có transcript</>
                            : <><Headphones size={15} aria-hidden="true" />Chỉ xem video</>}
                    </span>
                    <span className={s.cardCta} aria-hidden="true"><Play size={13} className="fill-current" />{item.practiceAvailable ? 'Luyện nghe' : 'Nghe'}</span>
                </div>
            </div>
        </article>
    );
};
