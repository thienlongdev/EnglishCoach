/**
 * Canonical presentation mappings for Speaking & Shadowing diagnostic categories.
 * Prevents raw internal model enums (e.g. PHONE_SUBSTITUTION) from leaking to learner UI.
 */

export const ISSUE_TYPE_VI_MAP: Record<string, string> = {
    PHONE_SUBSTITUTION: 'Thay thế âm',
    PHONE_DELETION: 'Bỏ âm',
    PHONE_INSERTION: 'Thêm âm',
    LEXICAL_STRESS_MISMATCH: 'Trọng âm từ',
    ARTICULATORY_DENTAL_MISMATCH: 'Khẩu hình âm răng (/θ/, /ð/)',
    ARTICULATORY_LABIODENTAL_MISMATCH: 'Khẩu hình âm môi-răng (/v/, /f/)',
    ARTICULATORY_ALVEOLAR_MISMATCH: 'Khẩu hình âm lợi / đầu lưỡi (/r/, /l/)',
    DISRUPTIVE_PAUSE: 'Ngắt nghỉ ngập ngừng',
    REFERENCE_RELATIVE_INTONATION: 'Ngữ điệu câu',
    UNCALIBRATED_RHYTHM_STATISTIC: 'Nhịp điệu câu',
    CONTENT_MISMATCH: 'Khớp nội dung',
    STRESS: 'Trọng âm từ',
    INTONATION: 'Ngữ điệu',
    RHYTHM: 'Nhịp điệu',
    FLUENCY: 'Độ trôi chảy',
    PHONEME: 'Âm vị',
    GRAMMAR: 'Ngữ pháp',
    VOCABULARY: 'Từ vựng',
    NATURALNESS: 'Độ tự nhiên',
};

/**
 * Returns a concise, truthful learner-facing Vietnamese label for any diagnostic issue code.
 * Guaranteed to never expose raw uppercase enums.
 */
export function getLearnerIssueLabel(issueType?: string | null, targetWord?: string | null): string {
    if (targetWord && targetWord.trim()) {
        return `Từ: "${targetWord.trim()}"`;
    }
    if (!issueType || !issueType.trim()) {
        return 'Mục tiêu luyện tập';
    }

    const key = issueType.trim().toUpperCase();
    if (ISSUE_TYPE_VI_MAP[key]) {
        return ISSUE_TYPE_VI_MAP[key];
    }

    // Substring fallback checks for combined keys like PHONE_SUBSTITUTION:θ
    if (key.includes('SUBSTITUTION')) return 'Thay thế âm';
    if (key.includes('DELETION')) return 'Bỏ âm';
    if (key.includes('INSERTION')) return 'Thêm âm';
    if (key.includes('STRESS')) return 'Trọng âm từ';
    if (key.includes('DENTAL')) return 'Âm răng (/θ/, /ð/)';
    if (key.includes('LABIODENTAL')) return 'Âm môi-răng (/v/, /f/)';
    if (key.includes('ALVEOLAR')) return 'Âm lợi / đầu lưỡi (/r/, /l/)';
    if (key.includes('PAUSE')) return 'Ngắt nghỉ câu';
    if (key.includes('INTONATION') || key.includes('PITCH')) return 'Ngữ điệu câu';
    if (key.includes('RHYTHM')) return 'Nhịp điệu câu';
    if (key.includes('FLUENCY')) return 'Độ trôi chảy';

    // If completely unknown, return neutral generic label rather than raw enum
    return 'Phát âm cần lưu ý';
}

/**
 * Maps high-level diagnostic category to friendly Vietnamese display string.
 */
export function getLearnerCategoryLabel(category?: string | null): string {
    if (!category) return 'Phát âm';
    const norm = category.toUpperCase().trim();
    if (norm === 'PRONUNCIATION') return 'Phát âm';
    if (norm === 'GRAMMAR') return 'Ngữ pháp';
    if (norm === 'VOCABULARY') return 'Từ vựng';
    if (norm === 'STRESS') return 'Trọng âm';
    if (norm === 'NATURALNESS') return 'Độ tự nhiên';
    return ISSUE_TYPE_VI_MAP[norm] || 'Phát âm';
}
