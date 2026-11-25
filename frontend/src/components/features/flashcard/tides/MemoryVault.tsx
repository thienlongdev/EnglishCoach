"use client";

import React, { useMemo, useState } from "react";
import useSWR from "swr";
import { ArrowLeft } from "lucide-react";
import { BrandWhaleIcon } from "@/components/common/BrandWhaleIcon";
import { fetchMemoryOverview } from "@/services/flashcardMemoryApi";
import type { MemoryOverview, MemoryTier, ReefMilestone, VaultCard } from "@/types/flashcardMemory";
import { CardFusion } from "./CardFusion";
import { MemoryForge } from "./MemoryForge";
import tides from "./memoryTides.module.css";
import styles from "./memoryVault.module.css";

/**
 * Memory Universe (Echo Memory Tides 2.0): the learner's Card Vault and Memory Reef. Every number is a server value from
 * the learner's own persisted evidence (rating log since the feature started, accepted Fusion sentences, card status);
 * self-rated recall, review history and AI-verified usage are labelled separately and never mixed. No AI on load.
 */

export const TIER_COPY: Record<MemoryTier, { name: string; rule: string }> = {
  RAW: { name: "Raw Memory", rule: "Từ chưa luyện." },
  SILVER: { name: "Silver Echo", rule: "Đã luyện ít nhất một lần." },
  PRISM: { name: "Holo Prism", rule: "Bạn đã tự dùng từ trong một câu Fusion được Echo chấp nhận." },
  PEARL: { name: "Eternal Pearl", rule: "Nhớ được (Tốt / Dễ) ở ít nhất 3 ngày khác nhau, cách nhau từ 14 ngày." },
};

const EVIDENCE_LABEL: Record<ReefMilestone["evidence"], string> = {
  REVIEW_HISTORY: "Lịch sử ôn tập",
  SELF_RATED_RECALL: "Tự đánh giá qua nhiều ngày",
  VERIFIED_USAGE: "Echo đã kiểm tra câu bạn viết",
};

function milestoneTitle(m: ReefMilestone): string {
  const [kind] = m.key.split("_");
  if (m.key.startsWith("TIDE_DAYS")) return m.target === 1 ? "Ngày ôn đầu tiên" : `${m.target} ngày ôn tập`;
  if (kind === "REVIEWS") return `${m.target.toLocaleString("vi-VN")} lượt đánh giá thẻ`;
  if (kind === "PEARLS") return m.target === 1 ? "Ngọc trai đầu tiên" : `${m.target} ngọc trai`;
  return m.target === 1 ? "Câu Fusion đầu tiên" : `${m.target} câu Fusion`;
}

const fmtDay = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("vi-VN") : "");

/** A small, deterministic pseudo-random sequence: the reef looks the same on every load for the same numbers. */
function seeded(n: number) {
  let x = (n * 9301 + 49297) % 233280;
  return () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
}

type Branch = { d: string; w: number };

/** One branching coral, grown from its base by a fixed recursion (depth 3): the same seed always grows the same coral. */
function growCoral(x: number, base: number, height: number, rnd: () => number, form: number, w0: number): Branch[] {
  const out: Branch[] = [];
  const grow = (x0: number, y0: number, angle: number, len: number, depth: number, w: number) => {
    const x1 = x0 + Math.sin(angle) * len, y1 = y0 - Math.cos(angle) * len;
    const bend = (rnd() - 0.5) * len * 0.35;
    const cx = (x0 + x1) / 2 + bend, cy = (y0 + y1) / 2;
    out.push({ d: `M${x0.toFixed(1)} ${y0.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`, w });
    if (depth === 0) return;
    // form 0: sea fan (wide, many short twigs) · 1: branching coral · 2: tube sponge (a few tall stems, no twigs)
    if (form === 2) return;
    const spread = form === 0 ? 0.55 + rnd() * 0.35 : 0.32 + rnd() * 0.26;
    const shrink = form === 0 ? 0.55 : 0.66;
    grow(x1, y1, angle - spread, len * (shrink + rnd() * 0.1), depth - 1, w * 0.66);
    grow(x1, y1, angle + spread, len * (shrink + rnd() * 0.1), depth - 1, w * 0.66);
    if (form === 0 && depth >= 2) grow(x1, y1, angle + (rnd() - 0.5) * 0.3, len * 0.5, depth - 2, w * 0.6);
  };
  if (form === 2) {
    const stems = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < stems; k++) grow(x + (k - stems / 2) * 4, base, (k - stems / 2) * 0.12, height * (0.45 + rnd() * 0.45), 0, w0 * 1.25);
  } else {
    grow(x, base, (rnd() - 0.5) * 0.25, height * (form === 0 ? 0.36 : 0.42), 3, w0);
  }
  return out;
}

const CORAL_HUES = [338, 14, 286, 188, 160, 32];

/**
 * Memory Reef: one branching coral per day with logged ratings (up to 36), a pearl resting in an open shell for each Pearl
 * card (up to 24), a glowing filament between two corals for each accepted Fusion (up to 12), and a pale bedrock when
 * cards carry progress from before the rating log existed (never turned into corals: those days were not recorded).
 * Everything is a pure function of the server's numbers; decoration is aria-hidden behind one labelled image.
 */
function Reef({ data, bedrock }: { data: MemoryOverview["reef"]; bedrock: number }) {
  const corals = Math.min(36, data.reviewDays);
  const pearls = Math.min(24, data.pearls);
  const links = Math.min(12, data.fusions);
  const scene = useMemo(() => {
    const rnd = seeded(corals * 31 + pearls * 7 + links + 1);
    const floor = (x: number) => 196 + Math.sin(x / 70) * 5 + Math.sin(x / 23) * 2;
    const c = Array.from({ length: corals }, (_, i) => {
      // corals fill the floor from the middle outwards, so a young reef is a small cluster, an old one a wide garden;
      // every third coral stands in a farther row (smaller, dimmer), which gives the reef depth
      const slot = i === 0 ? 0 : (i % 2 === 1 ? 1 : -1) * Math.ceil(i / 2);
      const x = 300 + slot * (540 / Math.max(10, corals)) + (rnd() - 0.5) * 12;
      const far = i % 3 === 2;
      const form = Math.floor(rnd() * 3);
      const h = (far ? 0.7 : 1) * (52 + rnd() * 62 + Math.min(26, corals * 0.7));
      const base = floor(x) - (far ? 9 : 0);
      const hue = CORAL_HUES[i % CORAL_HUES.length];
      return { x, base, far, hue, branches: growCoral(x, base, h, rnd, form, far ? 3 : 4.2), sway: 5 + rnd() * 4, delay: rnd() * -6 };
    }).sort((a, b) => Number(b.far) - Number(a.far));
    const p = Array.from({ length: pearls }, (_, i) => {
      const x = 40 + ((i + 0.5) * 520) / Math.max(1, pearls) + (rnd() - 0.5) * 14;
      return { x, y: floor(x) + 4 };
    });
    // a Fusion links two corals (or two points of the floor while the reef is still small)
    const l = Array.from({ length: links }, (_, i) => {
      const a = c.length > 1 ? c[(i * 3) % c.length] : null, b = c.length > 1 ? c[(i * 3 + 1 + (i % 2)) % c.length] : null;
      const x1 = a ? a.x : 120 + i * 30, x2 = b && b !== a ? b.x : 220 + i * 30;
      const y1 = (a ? a.base : 196) - 60 - rnd() * 30, y2 = (b ? b.base : 196) - 60 - rnd() * 30;
      return { d: `M${x1.toFixed(1)} ${y1.toFixed(1)} Q ${((x1 + x2) / 2).toFixed(1)} ${(Math.min(y1, y2) - 40 - rnd() * 30).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}` };
    });
    const snow = Array.from({ length: 18 }, () => ({ x: rnd() * 600, y: 10 + rnd() * 170, r: 0.8 + rnd() * 1.4, delay: rnd() * -14 }));
    return { c, p, l, snow, floorPath: `M0 ${floor(0)} ${Array.from({ length: 31 }, (_, k) => `L${k * 20} ${floor(k * 20).toFixed(1)}`).join(" ")} V230 H0Z` };
  }, [corals, pearls, links]);
  const rock = bedrock > 0 ? Math.min(1, 0.25 + Math.log10(1 + bedrock) / 4) : 0;
  return (
    <svg className={styles.reef} viewBox="0 0 600 230" preserveAspectRatio="xMidYMax slice" role="img"
      aria-label={`Rạn san hô: ${data.reviewDays} ngày ôn, ${data.pearls} ngọc trai, ${data.fusions} câu Fusion${bedrock > 0 ? `, nền đá ${bedrock} thẻ có tiến độ từ trước` : ""}`}>
      <defs>
        <linearGradient id="reefSea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0e7490" />
          <stop offset="0.55" stopColor="#164e63" />
          <stop offset="1" stopColor="#0b1530" />
        </linearGradient>
        <linearGradient id="reefShaft" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e0f2fe" stopOpacity="0.32" />
          <stop offset="1" stopColor="#e0f2fe" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="reefSand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b3f8f" />
          <stop offset="1" stopColor="#1e1b4b" />
        </linearGradient>
        <radialGradient id="reefPearl" cx="0.34" cy="0.28" r="0.85">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#ecfeff" />
          <stop offset="0.75" stopColor="#c7d2fe" />
          <stop offset="1" stopColor="#99f6e4" />
        </radialGradient>
        <radialGradient id="reefGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#a5f3fc" stopOpacity="0.55" />
          <stop offset="1" stopColor="#a5f3fc" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="600" height="230" fill="url(#reefSea)" />
      {[110, 260, 430].map((x, i) => (
        <polygon key={`s${i}`} points={`${x},0 ${x + 46},0 ${x + 120},230 ${x + 30},230`} fill="url(#reefShaft)" className={styles.shaft} style={{ animationDelay: `${i * -2.6}s` }} />
      ))}
      {scene.snow.map((s, i) => <circle key={`n${i}`} cx={s.x} cy={s.y} r={s.r} className={styles.snow} style={{ animationDelay: `${s.delay}s` }} />)}
      {rock > 0 && (
        <path className={styles.bedrock} style={{ opacity: rock }}
          d="M0 230 V206 C 60 192 110 200 160 194 C 230 186 290 198 350 192 C 420 186 480 199 540 193 C 570 190 590 196 600 196 V230 Z" />
      )}
      <path d={scene.floorPath} fill="url(#reefSand)" />
      {scene.c.map((c, i) => (
        <g key={`c${i}`} className={styles.coral} data-far={c.far ? "true" : undefined} style={{ animationDuration: `${c.sway}s`, animationDelay: `${c.delay}s`, transformOrigin: `${c.x}px ${c.base}px` }}>
          {c.branches.map((b, k) => <path key={k} d={b.d} stroke={`hsl(${c.hue} 82% ${62 + (6.5 - b.w) * 3}%)`} strokeWidth={b.w} />)}
        </g>
      ))}
      {scene.l.map((l, i) => (
        <g key={`l${i}`}>
          <path d={l.d} className={styles.reefLinkGlow} />
          <path d={l.d} className={styles.reefLink} />
        </g>
      ))}
      {scene.p.map((p, i) => (
        <g key={`p${i}`}>
          <path d={`M${p.x - 10} ${p.y} Q ${p.x} ${p.y + 9} ${p.x + 10} ${p.y} Q ${p.x} ${p.y + 3} ${p.x - 10} ${p.y}Z`} className={styles.shell} />
          <circle cx={p.x} cy={p.y - 4} r="13" fill="url(#reefGlow)" className={styles.pearlGlow} style={{ animationDelay: `${i * -0.7}s` }} />
          <circle cx={p.x} cy={p.y - 4} r="5.2" fill="url(#reefPearl)" className={styles.reefPearl} />
        </g>
      ))}
      {rock > 0 && [70, 512, 214, 404].slice(0, Math.max(1, Math.round(rock * 4))).map((x, i) => (
        <g key={`r${i}`} className={styles.boulder}>
          <ellipse cx={x} cy={204} rx={20 - i * 2} ry={11 - i} />
          <ellipse cx={x + 16} cy={207} rx={11} ry={7} />
        </g>
      ))}
      {data.reviewDays === 0 && <text x="300" y="110" textAnchor="middle" className={styles.reefEmpty}>Rạn san hô sẽ lớn lên theo mỗi ngày bạn ôn tập</text>}
    </svg>
  );
}

function TierCard({ card, onForge }: { card: VaultCard; onForge?: () => void }) {
  const [light, setLight] = useState<{ x: number; y: number } | null>(null);
  return (
    <li
      className={styles.vaultCard}
      data-tier={card.tier}
      style={light ? ({ "--mx": `${light.x}%`, "--my": `${light.y}%` } as React.CSSProperties) : undefined}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        const r = e.currentTarget.getBoundingClientRect();
        setLight({ x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 });
      }}
      onPointerLeave={() => setLight(null)}
    >
      <span className={styles.vaultTier}>{TIER_COPY[card.tier].name}</span>
      <strong lang="en" className={styles.vaultWord}>{card.word}</strong>
      {card.meaning && <span className={styles.vaultMeaning}>{card.meaning}</span>}
      <span className={styles.vaultFacts}>
        {card.loggedReviews > 0 ? `${card.loggedReviews} lượt ôn · nhớ ${card.recallDays} ngày` : "Chưa có lượt ôn mới"}
        {card.pearlOn ? ` · Ngọc trai từ ${fmtDay(card.pearlOn)}` : ""}
      </span>
      {onForge && <button type="button" className={tides.linkButton} onClick={onForge}><BrandWhaleIcon size="xs" clean />Thử cách ghi nhớ khác</button>}
      <a className={tides.linkButton} href={`/knowledge-universe?word=${encodeURIComponent(card.word.trim().toLowerCase())}`}>Xem trong vũ trụ</a>
    </li>
  );
}

export function MemoryVault({ userScope, onBack }: { userScope: string | number | null; onBack: () => void }) {
  const { data, error, mutate, isLoading } = useSWR<MemoryOverview>(
    userScope ? ["/flashcards/memory/overview", userScope] : null,
    () => fetchMemoryOverview(),
    { revalidateOnFocus: false, dedupingInterval: 15000 },
  );
  const [forge, setForge] = useState<{ id: number; word: string } | null>(null);
  const [tierFilter, setTierFilter] = useState<MemoryTier | "ALL">("ALL");

  // each link shown once: the most connected word first takes all its links, then the next word takes what is left
  const synapseGroups = useMemo(() => {
    const edges = new Set((data?.synapses ?? []).map((s) => [s.firstWord, s.secondWord].sort().join("\u0000")));
    const groups: Array<[string, string[]]> = [];
    while (edges.size > 0 && groups.length < 12) {
      const degree = new Map<string, number>();
      edges.forEach((e) => e.split("\u0000").forEach((w) => degree.set(w, (degree.get(w) ?? 0) + 1)));
      const hub = Array.from(degree.entries()).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
      const links: string[] = [];
      edges.forEach((e) => {
        const [a, b] = e.split("\u0000");
        if (a === hub || b === hub) { links.push(a === hub ? b : a); edges.delete(e); }
      });
      groups.push([hub, links.sort()]);
    }
    return groups;
  }, [data?.synapses]);

  const vault = (data?.vault ?? []).filter((c) => tierFilter === "ALL" || c.tier === tierFilter);

  return (
    <div className={styles.world}>
      <div className={styles.inner}>
        <div className={styles.topBar}>
          <button type="button" className={tides.secondary} onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" />Quay lại kho bộ từ</button>
          <h1 className={styles.title}>Memory Universe</h1>
        </div>

        {error && !data && (
          <p className={tides.error} role="alert">Không tải được Memory Universe. <button type="button" className={tides.linkish} onClick={() => void mutate()}>Thử lại</button></p>
        )}
        {(isLoading || (!data && !error)) && <div className={styles.skeleton} aria-busy="true" />}

        {data && (
          <>
            <section className={styles.panel} aria-labelledby="reef-title">
              <header className={styles.panelHead}>
                <div>
                  <h2 id="reef-title">Memory Reef</h2>
                  <p>
                    {data.reef.firstLoggedDay
                      ? `Lớn lên từ lịch sử ôn tập của bạn, ghi nhận từ ${fmtDay(data.reef.firstLoggedDay)}.`
                      : "Rạn san hô ghi nhận các lượt ôn từ nay về sau."}
                  </p>
                  {(data.practisedBeforeLog ?? 0) > 0 && (
                    <p className={tides.note}>
                      {`${(data.practisedBeforeLog ?? 0).toLocaleString("vi-VN")} thẻ đã có tiến độ từ trước khi rạn san hô bắt đầu ghi nhận. Tiến độ đó được giữ nguyên (Silver Echo) và là nền đá dưới rạn; những ngày ôn cũ không được ghi lại nên không thành san hô.`}
                    </p>
                  )}
                </div>
              </header>
              <Reef data={data.reef} bedrock={data.practisedBeforeLog ?? 0} />
              <dl className={styles.reefStats}>
                <div><dt>Ngày ôn tập</dt><dd>{data.reef.reviewDays}</dd></div>
                <div><dt>Lượt đánh giá</dt><dd>{data.reef.loggedReviews.toLocaleString("vi-VN")}</dd></div>
                <div><dt>Ngọc trai</dt><dd>{data.reef.pearls}</dd></div>
                <div><dt>Câu Fusion</dt><dd>{data.reef.fusions}</dd></div>
              </dl>
              <ul className={styles.milestones}>
                {data.reef.milestones.map((m) => (
                  <li key={m.key} data-reached={m.reachedOn ? "true" : "false"}>
                    <span className={styles.milestoneDot} aria-hidden="true" />
                    <span className={styles.milestoneText}>
                      <strong>{milestoneTitle(m)}</strong>
                      <small>{EVIDENCE_LABEL[m.evidence]} · {m.reachedOn ? `đạt ngày ${fmtDay(m.reachedOn)}` : `${Math.min(m.value, m.target)}/${m.target}`}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.panel} aria-labelledby="vault-title">
              <header className={styles.panelHead}>
                <div>
                  <h2 id="vault-title">Card Vault</h2>
                  <p>Vẻ ngoài của thẻ đi theo bằng chứng đã lưu, không theo lịch ôn — và không bao giờ bị hạ cấp.</p>
                </div>
              </header>
              <div className={styles.tierRow} role="group" aria-label="Lọc theo cấp thẻ">
                <button type="button" aria-pressed={tierFilter === "ALL"} onClick={() => setTierFilter("ALL")}>Tất cả <small>{data.tiers.total}</small></button>
                {(["PEARL", "PRISM", "SILVER", "RAW"] as MemoryTier[]).map((t) => (
                  <button key={t} type="button" aria-pressed={tierFilter === t} data-tier={t} onClick={() => setTierFilter(t)} title={TIER_COPY[t].rule}>
                    {TIER_COPY[t].name} <small>{data.tiers[t.toLowerCase() as "raw" | "silver" | "prism" | "pearl"]}</small>
                  </button>
                ))}
              </div>
              <p className={tides.note}>{tierFilter === "ALL" ? "Quy tắc: " : ""}{tierFilter === "ALL"
                ? "Silver Echo — đã luyện; Holo Prism — tự dùng từ trong câu Fusion được chấp nhận; Eternal Pearl — nhớ được ở ít nhất 3 ngày khác nhau cách nhau từ 14 ngày."
                : TIER_COPY[tierFilter].rule}</p>
              {vault.length === 0 ? (
                <p className={tides.note}>{tierFilter === "RAW" ? "Thẻ Raw Memory là những từ chưa luyện; hãy mở một bộ từ để bắt đầu." : "Chưa có thẻ nào ở cấp này. Mỗi lượt ôn từ hôm nay sẽ được ghi nhận."}</p>
              ) : (
                <ul className={styles.vaultGrid}>
                  {vault.map((c) => <TierCard key={c.flashcardId} card={c} />)}
                </ul>
              )}
            </section>

            <section className={styles.panel} aria-labelledby="weak-title">
              <header className={styles.panelHead}>
                <div>
                  <h2 id="weak-title">Từ hay quên</h2>
                  <p>Những từ bạn chọn Khó ở ít nhất hai ngày khác nhau trong 30 ngày qua. Không có gì sai cả — chỉ cần một cách nhớ khác.</p>
                </div>
              </header>
              {data.weak.length === 0 ? (
                <p className={tides.note}>Hiện chưa có từ nào như vậy.</p>
              ) : (
                <ul className={styles.vaultGrid}>
                  {data.weak.map((c) => <TierCard key={c.flashcardId} card={c} onForge={() => setForge({ id: c.flashcardId, word: c.word })} />)}
                </ul>
              )}
            </section>

            <CardFusion onLinked={() => void mutate()} />

            <section className={styles.panel} aria-labelledby="synapse-title">
              <header className={styles.panelHead}>
                <div>
                  <h2 id="synapse-title">Synapse</h2>
                  <p>Các cặp từ bạn đã dùng cùng nhau trong câu được Echo chấp nhận.</p>
                </div>
              </header>
              {synapseGroups.length === 0 ? (
                <p className={tides.note}>Chưa có liên kết nào. Hoàn thành một Card Fusion để tạo liên kết đầu tiên.</p>
              ) : (
                <>
                  <ul className={styles.synapseGroups}>
                    {synapseGroups.map(([word, links]) => (
                      <li key={word}><strong lang="en">{word}</strong><span aria-hidden="true">⟷</span><span lang="en">{Array.from(links).join(", ")}</span></li>
                    ))}
                  </ul>
                  <ul className={styles.synapseList}>
                    {data.synapses.slice(0, 12).map((s) => (
                      <li key={s.id}>
                        <span className={styles.synapsePair} lang="en">{s.firstWord} + {s.secondWord}</span>
                        <q lang="en">{s.sentence}</q>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        )}
      </div>
      <MemoryForge card={forge} open={!!forge} onClose={() => setForge(null)} />
    </div>
  );
}

export default MemoryVault;
