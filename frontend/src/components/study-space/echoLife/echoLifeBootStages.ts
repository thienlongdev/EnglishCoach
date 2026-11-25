/**
 * Zero-dependency canonical Echo Life pre-entry boot stage definitions and types.
 *
 * Intentionally imports ZERO Three.js, asset manifest, or WebGL modules so static entrypoints
 * (`StudySpaceEntry.tsx`, `EchoLifeLoadingOverlay.tsx`) keep the initial route bundle minimal.
 *
 * All 5 pre-entry stage labels stay in Vietnamese (Two-Phase Language Boundary, TASK 1 §11.2);
 * once the loading overlay dismisses, in-world Echo Life stays 100% English.
 */

export type EchoLifeBootStageId = 'preparing' | 'assets' | 'graphics' | 'sync' | 'ready';

export type EchoLifeBootGate = 'G0_room' | 'G1_world';

export type EchoLifeBootStatus =
  | 'running'
  | 'paused_hidden'
  | 'slow'
  | 'ready'
  | 'degraded_ready'
  | 'error';

export interface EchoLifeBootStageSpec {
  readonly id: EchoLifeBootStageId;
  readonly label: string;
}

export const ECHO_LIFE_BOOT_STAGES: readonly EchoLifeBootStageSpec[] = Object.freeze([
  Object.freeze({ id: 'preparing', label: 'Đang chuẩn bị Không gian học tập' }),
  Object.freeze({ id: 'assets', label: 'Đang tải môi trường và nhân vật' }),
  Object.freeze({ id: 'graphics', label: 'Đang tối ưu đồ họa' }),
  Object.freeze({ id: 'sync', label: 'Đang đồng bộ thế giới' }),
  Object.freeze({ id: 'ready', label: 'Sắp sẵn sàng khám phá' }),
]);

export const BOOT_STAGE_ORDER: readonly EchoLifeBootStageId[] = Object.freeze([
  'preparing',
  'assets',
  'graphics',
  'sync',
  'ready',
]);

export const BOOT_STAGE_LABELS_VI: Readonly<Record<EchoLifeBootStageId, string>> = Object.freeze({
  preparing: 'Đang chuẩn bị Không gian học tập',
  assets: 'Đang tải môi trường và nhân vật',
  graphics: 'Đang tối ưu đồ họa',
  sync: 'Đang đồng bộ thế giới',
  ready: 'Sắp sẵn sàng khám phá',
});

export const BOOT_STAGE_INDEX_BY_ID: Readonly<Record<EchoLifeBootStageId, number>> = Object.freeze({
  preparing: 0,
  assets: 1,
  graphics: 2,
  sync: 3,
  ready: 4,
});

export interface BootWorkProgress {
  readonly completed: number;
  readonly total: number;
  readonly unitVi: string;
}

export interface BootProgressSnapshot {
  readonly gate: EchoLifeBootGate;
  readonly transitionMode: boolean;
  readonly stageId: EchoLifeBootStageId;
  readonly stageLabelVi: string;
  /** Strictly monotonic integer percentage `0..100`. */
  readonly progress: number;
  readonly status: EchoLifeBootStatus;
  /** True when overlay may dismiss (either fully complete or explicit user "Vào ngay" opt-in). */
  readonly done: boolean;
  /**
   * True ONLY when all required barriers finished cleanly without incomplete user bypass.
   * Callers MUST persist `ec_echo_life_warmed_v1` (`markEchoLifeWarmed()`) ONLY when `complete === true`.
   */
  readonly complete: boolean;
  /** Live Vietnamese sub-progress detail (e.g. `12/28 tệp môi trường`, paused-hidden notice, SwiftShader note). */
  readonly detailVi: string | null;
  /** Watchdog slow-load notice shown after 20 s without visible progress, escalating to user choice at 60 s. */
  readonly slowNoticeVi: string | null;
  /** Non-null only on fatal recoverable error (e.g. WebGL unavailable, lost context, required asset 404). */
  readonly errorVi: string | null;
  readonly work: BootWorkProgress | null;
  readonly degradedAssetCount: number;
  readonly elapsedMs: number;
  readonly noProgressVisibleMs: number;
  readonly detailKey: string;
}

/** Maps explicit `stageId` or legacy boot stage text and progress to the canonical 5 Vietnamese stages. */
export function resolveBootStageId(
  progress: number,
  stage?: string,
  stageId?: EchoLifeBootStageId,
): EchoLifeBootStageId {
  if (stageId && stageId in BOOT_STAGE_LABELS_VI) return stageId;

  const trimmed = (stage ?? '').trim();
  for (const spec of ECHO_LIFE_BOOT_STAGES) {
    if (trimmed === spec.label) return spec.id;
  }

  if (progress >= 96 || /\b(welcome|ready)\b/i.test(trimmed)) return 'ready';
  if (/sync|resident|world state/i.test(trimmed)) return 'sync';
  if (/shader|warm|lighting|graphics|compile|texture/i.test(trimmed)) return 'graphics';
  if (/model|room|character|rig|asset|placing|neighborhood/i.test(trimmed)) return 'assets';

  if (progress >= 82) return 'sync';
  if (progress >= 56) return 'graphics';
  if (progress >= 22) return 'assets';
  return 'preparing';
}
