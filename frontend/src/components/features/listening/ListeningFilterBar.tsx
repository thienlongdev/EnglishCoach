import React from 'react';
import { RotateCcw } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { glass as s } from './glass/ListeningGlass';

interface ListeningFilterBarProps {
    cefrLevel: string;
    setCefrLevel: (val: string) => void;
    topic: string;
    setTopic: (val: string) => void;
    accent: string;
    setAccent: (val: string) => void;
    onClear: () => void;
}

const CEFR_VALUES = ['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const ACCENT_VALUES = ['', 'American', 'British', 'Australian', 'Canadian'];
const TOPIC_VALUES = ['', 'Business', 'Daily Life', 'Travel', 'Education', 'Entertainment', 'Psychology', 'Technology'];

/** Personal-library filters (server query parameters of GET /listening/materials?personalOnly=true). */
export const ListeningFilterBar: React.FC<ListeningFilterBarProps> = ({
    cefrLevel,
    setCefrLevel,
    topic,
    setTopic,
    accent,
    setAccent,
    onClear
}) => {
    const { locale, t } = useLanguage();
    const hasActiveFilters = Boolean(cefrLevel || topic || accent);

    const getCefrLabel = (val: string) => (val === '' ? (t.allFilter || (locale === 'vi' ? 'Tất cả' : 'All')) : val);
    const getAccentLabel = (val: string) => (val === '' ? (t.allFilter || (locale === 'vi' ? 'Tất cả' : 'All')) : val);
    const getTopicLabel = (val: string) => (val === '' ? (t.allTopicsFilter || (locale === 'vi' ? 'Tất cả chủ đề' : 'All Topics')) : val);

    const group = (label: string, values: string[], current: string, set: (v: string) => void, name: (v: string) => string) => (
        <div className={s.filterGroup} role="group" aria-label={label.replace(/:$/, '')}>
            <span className={s.filterLabel}>{label.replace(/:$/, '')}</span>
            <div className={s.chips}>
                {values.map(val => (
                    <button key={val || 'all'} type="button" aria-pressed={current === val} onClick={() => set(val)} className={s.chip}>
                        {name(val)}
                    </button>
                ))}
            </div>
        </div>
    );

    return (
        <div className={`${s.panel} ${s.filters}`}>
            <div className={s.filterRow}>
                {group(t.filterLevel || (locale === 'vi' ? 'Cấp độ:' : 'Level:'), CEFR_VALUES, cefrLevel, setCefrLevel, getCefrLabel)}
                {group(t.filterAccent || (locale === 'vi' ? 'Giọng:' : 'Accent:'), ACCENT_VALUES, accent, setAccent, getAccentLabel)}
                {hasActiveFilters && (
                    <button type="button" onClick={onClear} className={`${s.btn} ${s.btnGhost} ${s.btnSm} ml-auto`}>
                        <RotateCcw size={14} aria-hidden="true" />
                        <span>{t.clearListeningFilters || (locale === 'vi' ? 'Xóa bộ lọc' : 'Clear Filters')}</span>
                    </button>
                )}
            </div>
            <div className={s.filterDivider} aria-hidden="true" />
            {group(t.filterTopic || (locale === 'vi' ? 'Chủ đề:' : 'Topic:'), TOPIC_VALUES, topic, setTopic, getTopicLabel)}
        </div>
    );
};
