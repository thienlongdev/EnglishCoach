'use client';

import type { ReactNode } from 'react';
import { ChevronsUp, MoveHorizontal, Repeat2, Snowflake, Timer, Wind, Zap } from 'lucide-react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';
import { TRIALS } from './rushTrials';

/**
 * Every real player action as one on-screen control: the same handler the keyboard uses, its key, cooldown, active and
 * unavailable states (with the reason). Nothing here is decorative — a skill that cannot act says why instead.
 */
export type SkillId = 'jump' | 'dodge' | 'sprint' | 'dash' | 'rush' | 'ICE_LOCK' | 'TIME_SNARE' | 'POSITION_SWAP';
export interface SkillView {
  id: SkillId; group: 'move' | 'boost' | 'tactic'; label: string; hint: string; icon: ReactNode;
  ready: boolean; active: boolean; cooldown: number; cooldownText: string; meter?: number; hold?: boolean; reason: string; big?: boolean;
}
export interface SkillFacts {
  trials: boolean; running: boolean; airborne: boolean; stamina: number; sprinting: boolean; dashCooldown: number; dashing: boolean;
  energy: number; rushing: boolean; dodgeCooldown: number; landing?: boolean;
  /** Version 6 keys (Ctrl dodges; S walks backward). */
  reforged?: boolean;
}

export function coreSkills(vi: boolean, f: SkillFacts): SkillView[] {
  const t = (a: string, b: string) => vi ? a : b;
  const notRunning = t('Chỉ dùng khi đang chạy', 'Only while running');
  const list: SkillView[] = [];
  if (f.trials) {
    list.push({ id: 'jump', group: 'move', big: true, label: t('Nhảy', 'Jump'), hint: 'Space', icon: <ChevronsUp size={22} strokeWidth={2.6} />,
      ready: f.running && !f.airborne, active: f.airborne, cooldown: 0, cooldownText: '', reason: f.airborne ? t('Đang trên không', 'Already in the air') : notRunning });
    list.push({ id: 'dodge', group: 'move', label: t('Né', 'Dodge'), hint: f.reforged ? 'Ctrl' : 'S', icon: <MoveHorizontal size={20} strokeWidth={2.4} />,
      ready: f.running && !f.airborne && f.dodgeCooldown <= 0, active: f.dodgeCooldown > TRIALS.dodgeCooldown - TRIALS.dodgeTime, cooldown: Math.min(1, f.dodgeCooldown / TRIALS.dodgeCooldown),
      cooldownText: f.dodgeCooldown > 0 ? f.dodgeCooldown.toFixed(1) : '', reason: f.dodgeCooldown > 0 ? t('Đang hồi', 'Cooling down') : f.airborne ? t('Chỉ né trên mặt đất', 'Only on the ground') : notRunning });
  }
  list.push({ id: 'sprint', group: 'boost', hold: true, label: t('Tăng tốc', 'Sprint'), hint: 'Shift', icon: <Wind size={20} strokeWidth={2.4} />,
    ready: f.running && f.stamina > 0, active: f.sprinting, cooldown: 0, cooldownText: '', meter: f.stamina / 100, reason: f.stamina <= 0 ? t('Hết thể lực — đợi hồi', 'Out of stamina — recovering') : notRunning });
  list.push({ id: 'dash', group: 'boost', label: 'Dash', hint: 'F', icon: <Zap size={20} strokeWidth={2.4} />,
    ready: f.running && f.dashCooldown <= 0, active: f.dashing, cooldown: Math.min(1, f.dashCooldown / 4), cooldownText: f.dashCooldown > 0 ? f.dashCooldown.toFixed(1) : '',
    reason: f.dashCooldown > 0 ? t('Đang hồi', 'Cooling down') : notRunning });
  list.push({ id: 'rush', group: 'boost', label: 'Echo Rush', hint: 'E', icon: <BrandWhaleIcon className="h-5 w-5" />,
    ready: f.running && f.energy >= 100 && !f.rushing, active: f.rushing, cooldown: 0, cooldownText: '', meter: f.energy / 100,
    reason: f.energy < 100 ? t('Mở cổng đúng để nạp năng lượng', 'Open correct gates to charge it') : notRunning });
  return list;
}

export function tacticSkills(vi: boolean, charges: number, cooldowns: Record<string, number>, elapsed: number, usable: (id: SkillId) => string | null): SkillView[] {
  const t = (a: string, b: string) => vi ? a : b;
  const defs: [SkillId, string, string, string, ReactNode][] = [
    ['ICE_LOCK', t('Khóa băng', 'Ice Lock'), 'Z', t('Khóa hướng đối thủ 1,2 giây', 'Locks a rival’s steering for 1.2 s'), <Snowflake key="i" size={18} />],
    ['TIME_SNARE', t('Bẫy thời gian', 'Time Snare'), 'X', t('Làm chậm đối thủ 1,8 giây', 'Slows a rival for 1.8 s'), <Timer key="t" size={18} />],
    ['POSITION_SWAP', t('Đổi vị trí', 'Swap'), 'C', t('Đổi chỗ với đối thủ cùng chặng', 'Swap places within this checkpoint'), <Repeat2 key="r" size={18} />],
  ];
  return defs.map(([id, label, hint, , icon]) => {
    const cooldown = Math.max(0, (cooldowns[id] ?? 0) - elapsed), blocked = usable(id);
    return { id, group: 'tactic' as const, label, hint, icon, ready: charges > 0 && cooldown <= 0 && !blocked, active: false, cooldown: Math.min(1, cooldown / 12),
      cooldownText: cooldown > 0 ? cooldown.toFixed(0) : '', reason: charges <= 0 ? t('Mở cổng đúng để có lượt kỹ năng', 'Open a correct gate to earn a charge') : cooldown > 0 ? t('Đang hồi', 'Cooling down') : blocked ?? '' };
  });
}

export function SkillBar({ vi, skills, onPress, onRelease, onDeny, charges }: {
  vi: boolean; skills: SkillView[]; onPress: (id: SkillId) => void; onRelease?: (id: SkillId) => void; onDeny: (id: SkillId) => void; charges?: number;
}) {
  const t = (a: string, b: string) => vi ? a : b;
  const groups: SkillView['group'][] = ['move', 'boost', 'tactic'];
  return <div className="rush-skillbar" role="group" aria-label={t('Kỹ năng', 'Skills')}>
    {groups.map(group => {
      const items = skills.filter(s => s.group === group);
      if (!items.length) return null;
      return <div key={group} className={`rush-skillgroup is-${group}`}>
        {group === 'tactic' && <span className="rush-charges" aria-label={t('Lượt kỹ năng', 'Tactical charges')}>{charges ?? 0}<small>/3</small></span>}
        {items.map(s => <button key={s.id} type="button" data-skill={s.id}
          className={`rush-skill-btn${s.big ? ' is-big' : ''}${s.ready ? ' is-ready' : ' is-unavailable'}${s.active ? ' is-active' : ''}`}
          aria-disabled={!s.ready} aria-pressed={s.hold ? s.active : undefined}
          aria-label={`${s.label} (${s.hint})${s.ready ? '' : ' — ' + s.reason}`} title={s.ready ? `${s.label} · ${s.hint}` : s.reason}
          style={{ ['--cd' as string]: s.cooldown, ['--meter' as string]: s.meter ?? 0 }}
          onPointerDown={e => {
            e.preventDefault();
            if (!s.ready) { onDeny(s.id); return; }
            if (s.hold) e.currentTarget.setPointerCapture(e.pointerId);
            onPress(s.id);
          }}
          onPointerUp={() => { if (s.hold) onRelease?.(s.id); }} onPointerCancel={() => { if (s.hold) onRelease?.(s.id); }} onLostPointerCapture={() => { if (s.hold) onRelease?.(s.id); }}
          onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); return; } /* Space is the jump key, never a button press */ if (e.key === 'Enter') { e.preventDefault(); if (e.repeat) return; if (s.ready) onPress(s.id); else onDeny(s.id); } }}
          onKeyUp={e => { if (e.key === ' ') e.preventDefault(); if (e.key === 'Enter' && s.hold) onRelease?.(s.id); }}>
          <span className="rush-skill-icon">{s.icon}</span>
          <span className="rush-skill-label">{s.label}</span>
          <kbd className="rush-skill-key">{s.hint}</kbd>
          {s.cooldown > 0 && <span className="rush-skill-cd" aria-hidden="true"><b>{s.cooldownText}</b></span>}
          {s.meter !== undefined && <span className="rush-skill-meter" aria-hidden="true"><i /></span>}
        </button>)}
      </div>;
    })}
  </div>;
}
