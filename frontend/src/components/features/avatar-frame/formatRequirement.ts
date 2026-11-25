import { AvatarFrameProgress, AvatarFrameCondition } from '@/types/avatarFrame';

export interface FormattedConditionRow {
  label: string;
  progressText: string;
}

export interface FormattedFrameRequirement {
  cardProgress: string;
  isMultiCondition: boolean;
  conditions: FormattedConditionRow[];
  single: {
    unlockRequirement: string;
    progressText: string;
    remainingText: string;
  };
}

/**
 * Extracts a concise human-readable rank name without parentheses/target duplication.
 * e.g. "CHALLENGER (2000 ELO)" -> "Challenger"
 *      "MASTER (1500 ELO)"     -> "Master"
 *      "GOLD"                  -> "Gold"
 */
function cleanRankName(rawTarget?: string): string {
  if (!rawTarget) return 'Xếp hạng';
  const nameOnly = rawTarget.split('(')[0].trim().toUpperCase();
  switch (nameOnly) {
    case 'CHALLENGER': return 'Challenger';
    case 'MASTER': return 'Master';
    case 'DIAMOND': return 'Kim Cương';
    case 'PLATINUM': return 'Bạch Kim';
    case 'GOLD': return 'Gold';
    case 'SILVER': return 'Bạc';
    case 'BRONZE': return 'Đồng';
    default:
      return nameOnly.charAt(0) + nameOnly.slice(1).toLowerCase();
  }
}

/**
 * Extracts a concise CEFR code without verbose IELTS duplicate mapping.
 * e.g. "C2 (IELTS 8.5+)" -> "C2"
 *      "C1 (IELTS 7.0+)" -> "C1"
 *      "B2 (IELTS 5.5+)" -> "B2"
 */
function cleanCefrLevel(rawTarget?: string): string {
  if (!rawTarget) return 'C2';
  const level = rawTarget.split('(')[0].trim().toUpperCase();
  return level || 'C2';
}

/**
 * Formats a metric-based progress line into compact Vietnamese copy.
 */
function formatSingleMetric(
  metric: string,
  current: number,
  target: number,
  displayCurrent?: string,
  displayTarget?: string
): {
  label: string;
  unlockRequirement: string;
  progressText: string;
  remainingText: string;
  cardProgress: string;
} {
  const diff = Math.max(0, Math.round((target - current) * 10) / 10);
  const metricType = (metric || '').toUpperCase().trim();

  switch (metricType) {
    case 'STREAK_DAYS': {
      const cur = Math.round(current);
      const tgt = Math.round(target);
      const rem = Math.max(0, tgt - cur);
      return {
        label: 'Streak',
        unlockRequirement: `Đạt ${tgt} ngày`,
        progressText: `${cur} / ${tgt} ngày`,
        remainingText: rem > 0 ? `${rem} ngày` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} ngày`,
      };
    }

    case 'VOCAB_MASTERED':
    case 'VOCABULARY_COUNT': {
      const cur = Math.round(current);
      const tgt = Math.round(target);
      const rem = Math.max(0, tgt - cur);
      return {
        label: 'Từ vựng',
        unlockRequirement: `Học ${tgt} từ`,
        progressText: `${cur} / ${tgt} từ`,
        remainingText: rem > 0 ? `${rem} từ` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} từ`,
      };
    }

    case 'READING_COMPLETED': {
      const cur = Math.round(current);
      const tgt = Math.round(target);
      const rem = Math.max(0, tgt - cur);
      return {
        label: 'Reading',
        unlockRequirement: `Đọc ${tgt} bài`,
        progressText: `${cur} / ${tgt} bài`,
        remainingText: rem > 0 ? `${rem} bài` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} bài`,
      };
    }

    case 'LISTENING_COMPLETED': {
      const cur = Math.round(current);
      const tgt = Math.round(target);
      const rem = Math.max(0, tgt - cur);
      return {
        label: 'Listening',
        unlockRequirement: `Nghe ${tgt} bài`,
        progressText: `${cur} / ${tgt} bài`,
        remainingText: rem > 0 ? `${rem} bài` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} bài`,
      };
    }

    case 'DICTATION_COMPLETED': {
      const cur = Math.round(current);
      const tgt = Math.round(target);
      const rem = Math.max(0, tgt - cur);
      return {
        label: 'Chính tả',
        unlockRequirement: `Chép chính tả ${tgt} bài`,
        progressText: `${cur} / ${tgt} bài`,
        remainingText: rem > 0 ? `${rem} bài` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} bài`,
      };
    }

    case 'WRITING_COMPLETED': {
      const cur = Math.round(current);
      const tgt = Math.round(target);
      const rem = Math.max(0, tgt - cur);
      return {
        label: 'Viết',
        unlockRequirement: `Viết ${tgt} bài`,
        progressText: `${cur} / ${tgt} bài`,
        remainingText: rem > 0 ? `${rem} bài` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} bài`,
      };
    }

    case 'GARDEN_LEARNING_DAYS':
    case 'GARDEN_HARVESTS':
    case 'GARDEN_GRADUATIONS':
    case 'GARDEN_MONUMENT_ERA': {
      // Echo Garden frames (V87): stored garden facts, evaluated by the server
      const cur = Math.max(0, Math.round(current));
      const tgt = Math.max(0, Math.round(target));
      const rem = Math.max(0, tgt - cur);
      const n = (v: number) => v.toLocaleString('vi-VN');
      const text = metricType === 'GARDEN_LEARNING_DAYS' ? { label: 'Ngày học trong Echo Garden', unit: 'ngày', goal: `Học ${n(tgt)} ngày đã xác nhận trong Echo Garden` }
        : metricType === 'GARDEN_HARVESTS' ? { label: 'Thu hoạch trong Echo Garden', unit: 'lần', goal: `Thu hoạch ${n(tgt)} lần trong Echo Garden` }
          : metricType === 'GARDEN_GRADUATIONS' ? { label: 'Cây ký ức tốt nghiệp', unit: 'cây', goal: `Tốt nghiệp ${n(tgt)} cây ký ức` }
            : { label: 'Kỷ nguyên Cây Tri Thức', unit: '', goal: `Cây Tri Thức đạt kỷ nguyên ${n(tgt)}` };
      const unit = text.unit ? ` ${text.unit}` : '';
      return {
        label: text.label,
        unlockRequirement: text.goal,
        progressText: `${n(cur)} / ${n(tgt)}${unit}`,
        remainingText: rem > 0 ? `${n(rem)}${unit}` : 'Đã đạt điều kiện',
        cardProgress: `${n(cur)} / ${n(tgt)}${unit}`,
      };
    }

    case 'GARDEN_COIN': {
      // Bought once with Echo Coins inside Echo Garden (never with money, never granted by progress)
      const price = Math.max(0, Math.round(target)).toLocaleString('vi-VN');
      return {
        label: 'Mua tại Echo Garden',
        unlockRequirement: `Mua bằng ${price} Đồng Echo trong Echo Garden`,
        progressText: `${price} Đồng Echo`,
        remainingText: 'Mở Echo Garden › Phần thưởng Echo',
        cardProgress: `${price} Đồng Echo`,
      };
    }

    case 'LEARNING_XP': {
      // Cumulative learning XP (all-time Activity points; RANKED lineage since V67)
      const cur = Math.max(0, Math.round(current));
      const tgt = Math.max(0, Math.round(target));
      const rem = Math.max(0, tgt - cur);
      const n = (v: number) => v.toLocaleString('vi-VN');
      return {
        label: 'XP học tập',
        unlockRequirement: `Tích lũy ${n(tgt)} XP`,
        progressText: `${n(cur)} / ${n(tgt)} XP`,
        remainingText: rem > 0 ? `${n(rem)} XP` : 'Đã đạt điều kiện',
        cardProgress: `${n(cur)} / ${n(tgt)} XP`,
      };
    }

    case 'PVP_RANK': {
      const rankName = cleanRankName(displayTarget);
      const curElo = Math.round(current);
      const tgtElo = Math.round(target);
      const hasTarget = tgtElo > 0;
      const remElo = Math.max(0, tgtElo - curElo);
      return {
        label: 'Xếp hạng',
        unlockRequirement: hasTarget ? `Đạt ${rankName}` : `Hạng ${rankName} (Chưa mở)`,
        progressText: hasTarget ? `${curElo} / ${tgtElo} ELO` : `${curElo} ELO`,
        remainingText: hasTarget ? (remElo > 0 ? `${remElo} ELO` : 'Đã đạt điều kiện') : 'Đang cập nhật mùa giải',
        cardProgress: hasTarget ? `${curElo} / ${tgtElo} ELO` : `${curElo} ELO`,
      };
    }

    case 'CEFR_LEVEL': {
      const level = cleanCefrLevel(displayTarget);
      const curScore = current;
      const tgtScore = target;
      const remScore = Math.max(0, Math.round((tgtScore - curScore) * 10) / 10);
      const hasScore = curScore > 0;
      return {
        label: 'Chuẩn hóa',
        unlockRequirement: `Đạt ${level}`,
        progressText: hasScore ? `${curScore} / ${tgtScore} IELTS` : `Chưa thi / IELTS ${tgtScore}`,
        remainingText: remScore > 0 ? (hasScore ? `+${remScore} Band` : `Đạt IELTS ${tgtScore}+`) : 'Đã đạt điều kiện',
        cardProgress: hasScore ? `${curScore} / ${tgtScore} IELTS` : `Chưa thi / ${level}`,
      };
    }

    case 'SPECIAL_GRANT':
    case 'LEGACY_DATE':
    case 'ADMIN_GRANT': {
      return {
        label: 'Đặc quyền',
        unlockRequirement: 'Đặc quyền danh hiệu hệ thống cấp phát',
        progressText: 'Đặc cách',
        remainingText: 'Sở hữu vĩnh viễn',
        cardProgress: 'Đặc cách',
      };
    }

    case 'PREMIUM_PLAN':
    case 'PREMIUM_SUBSCRIPTION': {
      const tgt = Math.round(target || 1);
      const cur = Math.round(current);
      const rem = Math.max(0, tgt - cur);
      const planName = tgt >= 12 ? 'Premium 12 tháng' : tgt >= 3 ? 'Premium 3 tháng' : 'Premium 1 tháng';
      return {
        label: 'Hội viên',
        unlockRequirement: `Gói ${planName}`,
        progressText: `${cur} / ${tgt} tháng`,
        remainingText: rem > 0 ? (cur === 0 ? `Cần gói ${tgt} tháng` : `Thiếu ${rem} tháng`) : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt} tháng`,
      };
    }

    case 'EVENT_ATTENDANCE':
    case 'EVENT_PARTICIPATION': {
      const cur = Math.round(current);
      const tgt = Math.round(target || 1);
      const eventName = displayTarget === 'TET_2026' ? 'Tết Cổ Truyền' : (displayTarget || 'Sự kiện');
      const isConnected = cur > 0 || tgt > 1;
      return {
        label: 'Sự kiện',
        unlockRequirement: `Sự kiện ${eventName} (Chưa mở)`,
        progressText: isConnected ? `${cur} / ${tgt}` : 'Chưa kết nối',
        remainingText: isConnected ? (cur >= tgt ? 'Đã hoàn thành' : 'Tham gia sự kiện') : 'Sắp diễn ra',
        cardProgress: isConnected ? `${cur} / ${tgt}` : 'Sắp diễn ra',
      };
    }

    default: {
      const cur = Math.round(current);
      const tgt = Math.round(target || 1);
      const rem = Math.max(0, tgt - cur);
      const unit = metricType ? metricType.toLowerCase() : '';
      return {
        label: 'Tiến độ',
        unlockRequirement: `Đạt ${tgt}${unit ? ` ${unit}` : ''}`,
        progressText: `${cur} / ${tgt}${unit ? ` ${unit}` : ''}`,
        remainingText: rem > 0 ? `${rem}${unit ? ` ${unit}` : ''}` : 'Đã đạt điều kiện',
        cardProgress: `${cur} / ${tgt}`,
      };
    }
  }
}

/**
 * Shared presentation formatter for Avatar Frame requirements and progress.
 * Adheres strictly to the compact, non-repetitive 3-row layout and short card progress.
 */
export function formatAvatarFrameRequirement(
  progress: AvatarFrameProgress | null | undefined
): FormattedFrameRequirement {
  if (!progress) {
    return {
      cardProgress: 'Đặc cách',
      isMultiCondition: false,
      conditions: [],
      single: {
        unlockRequirement: 'Đặc quyền danh hiệu hệ thống cấp phát',
        progressText: 'Đặc cách',
        remainingText: 'Sở hữu vĩnh viễn',
      },
    };
  }

  // Handle multi-condition frames if conditions array has > 1 item
  if (progress.conditions && progress.conditions.length > 1) {
    const formattedConditions: FormattedConditionRow[] = progress.conditions.map((c) => {
      const formatted = formatSingleMetric(c.metric, c.current, c.target, c.displayCurrent, c.displayTarget);
      return {
        label: formatted.label,
        progressText: formatted.progressText,
      };
    });

    const bottleneck = formatSingleMetric(
      progress.metric,
      progress.current,
      progress.target,
      progress.displayCurrent,
      progress.displayTarget
    );

    return {
      cardProgress: bottleneck.cardProgress,
      isMultiCondition: true,
      conditions: formattedConditions,
      single: {
        unlockRequirement: bottleneck.unlockRequirement,
        progressText: bottleneck.progressText,
        remainingText: bottleneck.remainingText,
      },
    };
  }

  // Single-condition frames (Fixed 3-row presentation)
  const single = formatSingleMetric(
    progress.metric,
    progress.current,
    progress.target,
    progress.displayCurrent,
    progress.displayTarget
  );

  return {
    cardProgress: single.cardProgress,
    isMultiCondition: false,
    conditions: [
      {
        label: single.label,
        progressText: single.progressText,
      },
    ],
    single: {
      unlockRequirement: single.unlockRequirement,
      progressText: single.progressText,
      remainingText: single.remainingText,
    },
  };
}
