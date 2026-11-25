"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Compass, Home, MessageCircleHeart, Search, ShieldCheck, Users, X } from "lucide-react";
import type {
  GardenActivityPage, GardenIsland, GardenIslandCard, GardenIslandProtection, GardenPlot, GardenStanding,
} from "@/types/garden";
import type { EchoGardenGame } from "./useEchoGarden";
import type { GardenSocial } from "./useGardenSocial";
import { ActionButton, Chip, EASE, FOCUS_RING, GardenSheet, PANEL } from "./gardenUi";
import {
  ERA_LABEL, REACTION_LABEL, STAGE_LABEL, TIER_LABEL, cropIconUrl, formatDuration, formatNumber, momentText, portionText,
  projectGrowth, takeReasonText,
} from "./gardenModel";

/*
 * Phase 3G: Social Islands. Everything shown here is a server fact about a REAL garden player: there are no invented
 * players, ratings or statistics, and an empty list is shown as empty. A visited island is read-only — the only action
 * a visitor has is "Lấy một ít" on a ripe crop the server marks eligible (choose → confirm), plus one preset greeting.
 */

export type SocialTab = "discover" | "visited" | "activity" | "mine";

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button type="button" onClick={onClose} aria-label={label}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/80 transition-[background-color,color,transform] duration-200 ${EASE} hover:bg-white/20 hover:text-white active:scale-[0.94] ${FOCUS_RING} cursor-pointer sm:h-9 sm:w-9`}>
      <X className="h-4 w-4" />
    </button>
  );
}

const BOX = "rounded-[16px_13px_16px_14px] border border-white/10 bg-black/20 p-3";

/** "EG-AB12CD34": the public island code a player can share or search for. */
export function handleText(handle: string): string {
  return `EG-${handle}`;
}

function protectionLine(p: GardenIslandProtection): string {
  return p.active ? takeReasonText(p.reason, p.until) : "Đảo đang mở cửa và không trong thời gian bảo vệ.";
}

function standingLine(s: GardenStanding): string {
  return s.canTake ? `Bạn còn ${s.takesLeft} lần "Lấy một ít" trong 24 giờ.` : takeReasonText(s.reason, s.availableAt);
}

/** One real island: public name, island code and stored progression facts; the whole row travels there. */
function IslandRow({ card, busy, onVisit }: { card: GardenIslandCard; busy: boolean; onVisit: () => void }) {
  return (
    <li className={`${BOX} flex items-center gap-3`} data-testid={`social-island-${card.handle}`}>
      {/* a light preview: the game's own key art, never a second live scene */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/games/echo-garden/key-art.webp" alt="" aria-hidden loading="lazy" decoding="async" draggable={false}
        className="h-14 w-14 shrink-0 rounded-[14px_11px_14px_12px] object-cover" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-black text-[#EEF3FF]">{card.name}</p>
        <p className="text-[10px] font-semibold tabular-nums text-[#EEF3FF]/50">{handleText(card.handle)}</p>
        <p className="mt-1 flex flex-wrap gap-1">
          <Chip tone="good">Cấp {card.level}</Chip>
          <Chip>{card.beds} luống</Chip>
          {card.monumentEra > 0 && <Chip tone="magic">{ERA_LABEL[card.monumentEra] ?? `Kỷ ${card.monumentEra}`}</Chip>}
          {card.forestTrees > 0 && <Chip tone="info">{formatNumber(card.forestTrees)} cây tốt nghiệp</Chip>}
        </p>
        {card.visitedAt && <p className="mt-1 text-[10px] text-[#EEF3FF]/50">Bạn đã ghé lúc {momentText(card.visitedAt)}</p>}
      </div>
      <ActionButton tone="care" className="min-h-[40px] shrink-0 px-3 text-xs" onClick={onVisit} disabled={busy} testId={`social-visit-${card.handle}`}
        ariaLabel={`Ghé thăm đảo của ${card.name}`}>
        Ghé thăm
      </ActionButton>
    </li>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className={`${BOX} mt-3 text-center`} data-testid="social-empty">
      <p className="text-[13px] font-bold text-[#EEF3FF]">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/65">{note}</p>
    </div>
  );
}

/** The social sheet: discover real islands, islands visited, the island's activity record, the player's own island. */
export function SocialPanel({ game, social, initialTab = "discover", onClose, onVisit }: {
  game: EchoGardenGame;
  social: GardenSocial;
  initialTab?: SocialTab;
  onClose: () => void;
  onVisit: (handle: string) => void;
}) {
  const [tab, setTab] = useState<SocialTab>(initialTab);
  const [islands, setIslands] = useState<GardenIslandCard[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [query, setQuery] = useState("");
  const [visitedList, setVisitedList] = useState<GardenIslandCard[] | null>(null);
  const [page, setPage] = useState<GardenActivityPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const unread = game.state?.social?.unread ?? 0;
  const { loadMe, discover, visited, activity, markSeen } = social;
  const seenSent = useRef(false);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const runDiscover = useCallback(async (q: string, from: string | null) => {
    setLoading(true);
    const result = await discover(from, q);
    setLoading(false);
    if (!result) return;
    setIslands((list) => (from && list ? [...list, ...result.islands] : result.islands));
    setCursor(result.nextCursor);
    setSearched(result.search);
  }, [discover]);

  useEffect(() => {
    if (tab === "discover" && islands === null) void runDiscover("", null);
    if (tab === "visited" && visitedList === null) void visited().then((r) => r && setVisitedList(r.islands));
    if (tab === "activity" && page === null) {
      void activity(null).then((r) => {
        if (!r) return;
        setPage(r);
        // the record was just shown: mark it read once (the unread lines of this view stay highlighted)
        if (r.unread > 0 && !seenSent.current) {
          seenSent.current = true;
          void markSeen();
        }
      });
    }
  }, [tab, islands, visitedList, page, runDiscover, visited, activity, markSeen]);

  const more = async () => {
    if (!page?.nextBefore) return;
    const next = await activity(page.nextBefore);
    if (next) setPage({ ...page, entries: [...page.entries, ...next.entries], nextBefore: next.nextBefore });
  };

  const me = social.me;
  const tabs: Array<{ id: SocialTab; label: string }> = [
    { id: "discover", label: "Khám phá đảo" },
    { id: "visited", label: "Đảo đã ghé thăm" },
    { id: "activity", label: "Hoạt động trên đảo" },
    { id: "mine", label: "Đảo của tôi" },
  ];
  const visitBusy = social.loadingHandle !== null;

  return (
    <GardenSheet labelledBy="garden-social-title" onClose={onClose} testId="garden-social-panel" wide>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold text-[#9cefe0]">Người chơi thật trên Echo Garden</p>
          <h2 id="garden-social-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Quần đảo bạn bè</h2>
        </div>
        <CloseButton onClose={onClose} label="Đóng bảng Quần đảo bạn bè" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1.5" role="tablist" aria-label="Quần đảo bạn bè">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`social-tab-${t.id}`} onClick={() => setTab(t.id)}
            className={`relative min-h-[40px] rounded-[14px_11px_14px_12px] border px-2 text-[12px] font-bold transition-colors duration-200 ${EASE} ${FOCUS_RING} cursor-pointer ${tab === t.id ? "border-[#FFE2A0]/45 bg-[#FFE2A0]/12 text-[#FFE7A8]" : "border-white/10 bg-white/[0.05] text-[#EEF3FF]/75 hover:bg-white/[0.1]"}`}>
            {t.label}
            {t.id === "activity" && unread > 0 && (
              <span className="ml-1.5 rounded-full bg-[#F2777A] px-1.5 py-0.5 text-[10px] font-black tabular-nums text-white" data-testid="social-unread">{unread}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "discover" && (
        <div role="tabpanel" data-testid="social-discover">
          <form className="mt-3 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void runDiscover(query.trim(), null); }}>
            <label className="sr-only" htmlFor="social-search">Tìm theo tên người chơi hoặc mã đảo</label>
            <input id="social-search" data-testid="social-search" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={40}
              placeholder="Tên người chơi hoặc mã đảo EG-…" autoComplete="off"
              className={`min-h-[44px] min-w-0 flex-1 rounded-[14px_11px_14px_12px] border border-white/12 bg-black/25 px-3 text-[13px] text-[#EEF3FF] placeholder:text-[#EEF3FF]/40 ${FOCUS_RING}`} />
            {/* Enter submits the form; the button (type="button") runs the same search */}
            <ActionButton tone="quiet" className="px-3" ariaLabel="Tìm đảo" testId="social-search-go" disabled={loading}
              onClick={() => void runDiscover(query.trim(), null)}>
              <Search className="h-4 w-4" aria-hidden />
            </ActionButton>
          </form>
          {searched && (
            <button type="button" onClick={() => { setQuery(""); void runDiscover("", null); }}
              className={`mt-2 rounded-lg px-1.5 py-1 text-[11px] font-semibold text-[#EEF3FF]/60 hover:text-[#EEF3FF] ${FOCUS_RING} cursor-pointer`}>
              Xóa tìm kiếm, xem tất cả đảo đang mở
            </button>
          )}
          {islands === null ? <p className="mt-4 text-center text-[12px] text-[#EEF3FF]/60" aria-busy="true">Đang tìm các đảo đang mở cửa…</p>
            : islands.length === 0 ? (
              searched
                ? <Empty title="Không có đảo nào khớp" note="Chỉ những đảo đang mở cửa mới tìm thấy được. Hãy thử tên khác hoặc nhập đúng mã đảo." />
                : <Empty title="Chưa có đảo nào khác đang mở cửa" note="Khi có thêm người chơi Echo Garden mở cửa đảo, họ sẽ xuất hiện ở đây. Danh sách này chỉ gồm người chơi thật." />
            ) : (
              <ul className="mt-3 space-y-2" data-testid="social-island-list">
                {islands.map((c) => <IslandRow key={c.handle} card={c} busy={visitBusy} onVisit={() => onVisit(c.handle)} />)}
              </ul>
            )}
          {cursor && !searched && (
            <ActionButton tone="quiet" className="mt-3 w-full" onClick={() => void runDiscover("", cursor)} disabled={loading} testId="social-more">Xem thêm đảo</ActionButton>
          )}
        </div>
      )}

      {tab === "visited" && (
        <div role="tabpanel" data-testid="social-visited">
          {visitedList === null ? <p className="mt-4 text-center text-[12px] text-[#EEF3FF]/60" aria-busy="true">Đang tải…</p>
            : visitedList.length === 0 ? <Empty title="Bạn chưa ghé thăm đảo nào" note="Mở Khám phá đảo và chọn một đảo để ghé thăm. Đảo đã đóng cửa sẽ tạm ẩn khỏi danh sách này." />
              : (
                <ul className="mt-3 space-y-2">
                  {visitedList.map((c) => <IslandRow key={c.handle} card={c} busy={visitBusy} onVisit={() => onVisit(c.handle)} />)}
                </ul>
              )}
        </div>
      )}

      {tab === "activity" && (
        <div role="tabpanel" data-testid="social-activity">
          {page === null ? <p className="mt-4 text-center text-[12px] text-[#EEF3FF]/60" aria-busy="true">Đang tải…</p> : (
            <>
              {page.reactions.length > 0 && (
                <div className={`${BOX} mt-3`}>
                  <p className="text-[12px] font-bold text-[#EEF3FF]">Lời nhắn từ khách ghé thăm</p>
                  <ul className="mt-1.5 space-y-1">
                    {page.reactions.map((r) => (
                      <li key={`${r.visitorName}-${r.at}`} className="text-[12px] text-[#EEF3FF]/80">
                        <span className="font-bold text-[#EEF3FF]">{r.visitorName}</span>: “{REACTION_LABEL[r.code] ?? "Một lời chào thân thiện"}”
                        <span className="text-[#EEF3FF]/50"> · {momentText(r.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {page.entries.length === 0 ? (
                <Empty title="Chưa có hoạt động nào" note="Khi có người chơi lấy một ít nông sản trên đảo của bạn, tên người đó, loại cây, số lượng và thời điểm sẽ được ghi lại ở đây." />
              ) : (
                <ul className="mt-3 space-y-1.5" data-testid="social-activity-list">
                  {page.entries.map((a) => (
                    <li key={a.id} data-testid={`social-activity-${a.kind}`}
                      className={`${BOX} flex items-center gap-2.5 ${a.unread ? "border-[#F2A36B]/45" : ""}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={cropIconUrl(a.cropCode)} alt="" aria-hidden className="h-9 w-9 shrink-0 object-contain" draggable={false} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] leading-snug text-[#EEF3FF]/90">
                          {a.kind === "TAKEN_FROM_ME" ? (
                            <>Người chơi <span className="font-black text-[#EEF3FF]">{a.otherName}</span> đã lấy {portionText(a.portions, a.unitPortions)} {a.nameVi} chín từ đảo của bạn.</>
                          ) : (
                            <>Bạn đã lấy {portionText(a.portions, a.unitPortions)} {a.nameVi} chín từ đảo của <span className="font-black text-[#EEF3FF]">{a.otherName}</span>.</>
                          )}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-[#EEF3FF]/50">
                          <span>{momentText(a.at)}</span>
                          {a.unread && <Chip tone="warn">Mới</Chip>}
                          {a.otherHandle ? (
                            <button type="button" onClick={() => onVisit(a.otherHandle!)} disabled={visitBusy}
                              className={`rounded px-1 font-semibold text-[#9cefe0] underline-offset-2 hover:underline ${FOCUS_RING} cursor-pointer`}>
                              Ghé đảo {handleText(a.otherHandle)}
                            </button>
                          ) : <span>Đảo này hiện đóng cửa</span>}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {page.nextBefore && <ActionButton tone="quiet" className="mt-3 w-full" onClick={() => void more()}>Xem hoạt động cũ hơn</ActionButton>}
              <p className="mt-3 text-[11px] leading-relaxed text-[#EEF3FF]/50">Chỉ những lần lấy thành công mới được ghi lại. Lần thử bị từ chối không lấy được gì và không tạo thông báo.</p>
            </>
          )}
        </div>
      )}

      {tab === "mine" && (
        <div role="tabpanel" data-testid="social-mine">
          {!me ? <p className="mt-4 text-center text-[12px] text-[#EEF3FF]/60" aria-busy="true">Đang tải…</p> : (
            <>
              <div className={`${BOX} mt-3`}>
                <p className="text-[13px] font-black text-[#EEF3FF]">{me.name}</p>
                <p className="mt-0.5 text-[11px] text-[#EEF3FF]/60">Mã đảo của bạn: <span className="font-bold tabular-nums text-[#EEF3FF]" data-testid="social-my-handle">{handleText(me.handle)}</span></p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Chip tone={me.visibility === "PUBLIC" ? "good" : "quiet"} testId="social-visibility">{me.visibility === "PUBLIC" ? "Đang mở cửa đón khách" : "Đang đóng cửa"}</Chip>
                  {me.protection.active && <Chip tone="info"><ShieldCheck className="h-3 w-3" aria-hidden />Đang được bảo vệ</Chip>}
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-[#EEF3FF]/75">{protectionLine(me.protection)}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/75">{standingLine(me.standing)}</p>
                {me.visibility === "PUBLIC" ? (
                  confirmClose ? (
                    <div className="mt-3 rounded-[14px] border border-[#F2A36B]/35 bg-[#F2A36B]/10 p-2.5">
                      <p className="text-[12px] leading-relaxed text-[#ffd2b0]">Khi đóng cửa, không ai tìm thấy, ghé thăm hay lấy nông sản trên đảo của bạn, và bạn cũng không lấy được ở đảo khác. Mở lại sau đó cần chờ {me.rules.reopenHours} giờ mới được lấy.</p>
                      <div className="mt-2 flex gap-2">
                        <ActionButton tone="reward" className="min-h-[40px] flex-1 text-xs" disabled={social.busy !== null} testId="social-close-confirm"
                          onClick={() => void social.setVisibility("PRIVATE").then(() => setConfirmClose(false))}>Đóng cửa đảo</ActionButton>
                        <ActionButton tone="quiet" className="min-h-[40px] text-xs" onClick={() => setConfirmClose(false)}>Giữ nguyên</ActionButton>
                      </div>
                    </div>
                  ) : <ActionButton tone="quiet" className="mt-3 w-full" onClick={() => setConfirmClose(true)} testId="social-close">Đóng cửa đảo (riêng tư)</ActionButton>
                ) : (
                  <ActionButton tone="care" className="mt-3 w-full" disabled={social.busy !== null} onClick={() => void social.setVisibility("PUBLIC")} testId="social-open">Mở cửa đảo đón khách</ActionButton>
                )}
              </div>

              <div className={`${BOX} mt-2`}>
                <p className="text-[12px] font-bold text-[#EEF3FF]">Phần nông sản lẻ</p>
                {me.shares.length === 0 ? (
                  <p className="mt-1 text-[12px] text-[#EEF3FF]/60">Bạn chưa có phần lẻ nào. Đủ {me.rules.unitPortions} phần cùng loại cây và cùng hạng sẽ tự gộp thành 1 nông sản trong Kho.</p>
                ) : (
                  <>
                  <p className="mt-1 text-[11px] leading-snug text-[#EEF3FF]/60" data-testid="social-shares-note">
                    Đủ {me.rules.unitPortions} phần cùng loại và cùng hạng sẽ tự gộp thành 1 nông sản. Không muốn chờ? Mở Kho để bán các phần lẻ theo đúng tỉ lệ giá của một nông sản.
                  </p>
                  <ul className="mt-1.5 space-y-1" data-testid="social-shares">
                    {me.shares.map((s) => (
                      <li key={`${s.cropCode}-${s.tier}`} className="flex items-center gap-2 text-[12px] text-[#EEF3FF]/85">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={cropIconUrl(s.cropCode)} alt="" aria-hidden className="h-6 w-6 object-contain" draggable={false} />
                        <span className="flex-1">{s.nameVi} · hạng {TIER_LABEL[s.tier] ?? s.tier}</span>
                        <span className="font-bold tabular-nums">{s.portions}/{s.unitPortions} phần</span>
                      </li>
                    ))}
                  </ul>
                  </>
                )}
              </div>

              <div className={`${BOX} mt-2`} data-testid="social-rules">
                <p className="text-[12px] font-bold text-[#EEF3FF]">“Lấy một ít” hoạt động thế nào?</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-[#EEF3FF]/75">
                  <li>Khách chỉ lấy được {Math.round(me.rules.fractionBp / 100)}% một cây đã chín: 1 trong {me.rules.unitPortions} phần của một nông sản. Chủ đảo vẫn thu hoạch {me.rules.unitPortions - 1} phần còn lại.</li>
                  <li>Mỗi cây chỉ bị lấy một lần. Cây không bị nhổ, luống không mất, cây không phải mọc lại.</li>
                  <li>Không ai lấy được Đồng Echo, hạt giống, vật trang trí, Phiếu AI hay Premium của bạn.</li>
                  <li>Mỗi người lấy tối đa {me.rules.thiefCap} lần trong {me.rules.windowHours} giờ, và {me.rules.pairCap} lần ở cùng một đảo.</li>
                  <li>Mỗi đảo bị lấy tối đa {me.rules.victimCap} lần trong {me.rules.windowHours} giờ, và được bảo vệ {me.rules.shieldHours} giờ sau mỗi lần.</li>
                  <li>Cây vừa chín được dành cho chủ đảo {me.rules.ripeGraceMinutes} phút đầu. Đảo mới được bảo vệ {me.rules.introHours} giờ.</li>
                  <li>Mỗi lần bị lấy, bạn nhận thông báo ghi rõ tên người lấy, loại cây, số lượng và thời điểm.</li>
                  <li>Không muốn tham gia? Đóng cửa đảo bất cứ lúc nào, không mất phí.</li>
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </GardenSheet>
  );
}

/** HUD status of a visit (replaces the player's own status bar): whose island this is, and that it is a visit. */
export function VisitStatus({ island }: { island: GardenIsland }) {
  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="garden-visit-status">
      <div className={`${PANEL} flex min-h-[44px] max-w-[min(78vw,420px)] items-center gap-2 rounded-[16px_20px_16px_18px] px-3 py-1.5 sm:min-h-[40px]`}>
        <Users className="h-4 w-4 shrink-0 text-[#9cefe0]" aria-hidden />
        <div className="min-w-0">
          <p className="text-[10px] font-bold text-[#9cefe0]">Bạn đang thăm đảo</p>
          <p className="truncate text-[13px] font-black leading-tight text-[#EEF3FF]" data-testid="garden-visit-owner">{island.owner.name}</p>
        </div>
        <span className="whitespace-nowrap rounded-full bg-[#74C98B]/20 px-2 py-0.5 text-[11px] font-black text-[#a6e6b3]">Cấp {island.owner.level}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="quiet">{handleText(island.owner.handle)}</Chip>
        {island.protection.active
          ? <Chip tone="info" testId="garden-visit-protected"><ShieldCheck className="h-3 w-3" aria-hidden />Đảo đang được bảo vệ</Chip>
          : <Chip tone="good">Chỉ xem · không sửa được đảo này</Chip>}
      </div>
    </div>
  );
}

/** A bed of the visited island: what grows there and whether a little may be taken (choose → confirm). */
function VisitPlotCard({ island, plot, social, serverNowMs, onClose }: {
  island: GardenIsland; plot: GardenPlot; social: GardenSocial; serverNowMs: number; onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const p = plot.planting;
  const option = p ? island.takes.find((t) => t.plantingId === p.id) ?? null : null;
  const growth = p ? projectGrowth(p, island.stageThresholds, serverNowMs, Date.parse(island.serverNow)) : null;
  useEffect(() => setConfirm(false), [plot.id, option?.eligible]);
  return (
    <GardenSheet labelledBy="garden-visit-plot-title" onClose={onClose} testId="garden-visit-plot">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {p && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cropIconUrl(p.cropCode, p.skinArt)} alt="" aria-hidden className="h-11 w-11 shrink-0 object-contain" draggable={false} />
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-[#9cefe0]">Luống {plot.slot} · đảo của {island.owner.name}</p>
            <h2 id="garden-visit-plot-title" className="mt-0.5 truncate text-lg font-black text-[#EEF3FF]">{p ? p.nameVi : "Luống trống"}</h2>
          </div>
        </div>
        <CloseButton onClose={onClose} label="Đóng thẻ luống" />
      </div>
      {!p || !growth ? (
        <p className="mt-3 text-[13px] text-[#EEF3FF]/75">Luống này đang trống. Chỉ chủ đảo mới gieo trồng được ở đây.</p>
      ) : (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip tone={p.ready ? "good" : "quiet"}>{STAGE_LABEL[growth.stage] ?? ""}</Chip>
            {!p.ready && <Chip>Còn khoảng {formatDuration(growth.remainingSeconds)}</Chip>}
          </p>
          <div className={`${BOX} mt-3`} data-testid="garden-take-box" data-eligible={option?.eligible ? "true" : "false"}>
            {option?.eligible ? (
              <>
                <p className="text-[13px] font-bold text-[#EEF3FF]">Cây đã chín, bạn có thể lấy một ít</p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/75">
                  Bạn nhận {portionText(option.portions, island.unitPortions)} hạng Normal. Chủ đảo vẫn thu hoạch {island.unitPortions - option.portions} phần còn lại
                  và sẽ được báo tên bạn, loại cây, số lượng và thời điểm.
                </p>
                {confirm ? (
                  <div className="mt-2.5 flex gap-2">
                    <ActionButton tone="reward" className="flex-1" disabled={social.busy !== null} testId="garden-take-confirm"
                      onClick={() => void social.take(p.id).then(() => setConfirm(false))}>
                      Xác nhận lấy {option.portions} phần
                    </ActionButton>
                    <ActionButton tone="quiet" onClick={() => setConfirm(false)}>Thôi</ActionButton>
                  </div>
                ) : (
                  <ActionButton tone="reward" className="mt-2.5 w-full" onClick={() => setConfirm(true)} testId="garden-take">Lấy một ít</ActionButton>
                )}
              </>
            ) : (
              <>
                <p className="flex items-center gap-1.5 text-[13px] font-bold text-[#EEF3FF]">
                  <ShieldCheck className="h-4 w-4 text-[#7fd3f5]" aria-hidden />Chưa thể lấy ở cây này
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-[#EEF3FF]/75" data-testid="garden-take-reason" data-reason={option?.reason ?? ""}>
                  {takeReasonText(option?.reason, option?.availableAt)}
                </p>
              </>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[#EEF3FF]/50">Bạn không thể tưới, bón, gieo hay thu hoạch trên đảo của người khác.</p>
        </>
      )}
    </GardenSheet>
  );
}

/**
 * Everything a visitor sees over the scene: toasts, the way home, the island's protection and the visitor's own
 * allowance, one preset greeting, and the card of the bed they tapped. No owner control exists in this layer.
 */
export function VisitOverlay({ game, social, island, selectedSlot, onCloseSelection, onHome, onOpenSocial }: {
  game: EchoGardenGame;
  social: GardenSocial;
  island: GardenIsland;
  selectedSlot: number | null;
  onCloseSelection: () => void;
  onHome: () => void;
  onOpenSocial: () => void;
}) {
  const [greeting, setGreeting] = useState(false);
  const plot = selectedSlot ? island.plots.find((p) => p.slot === selectedSlot) ?? null : null;
  const ripe = island.takes.filter((t) => t.eligible).length;
  const reactions = social.me?.reactions ?? Object.keys(REACTION_LABEL);
  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-testid="garden-visit-overlay" data-island={island.owner.handle}>
      <style>{`@keyframes eg-toast{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}`}</style>
      <div className="absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+7.5rem)] flex flex-col items-center gap-2 px-4 sm:top-[calc(env(safe-area-inset-top,0px)+5.5rem)]" aria-live="polite" role="status">
        {game.toasts.map((t) => (
          <div key={t.id} data-testid={`garden-toast-${t.tone}`}
            className={`${PANEL} max-w-sm rounded-[16px_13px_16px_14px] px-3.5 py-2 text-[13px] font-semibold motion-safe:animate-[eg-toast_220ms_cubic-bezier(0.22,1,0.36,1)] ${t.tone === "error" ? "border-[#F2777A]/40 text-[#ffd3d4]" : "text-[#EEF3FF]"}`}>
            {t.text}
          </div>
        ))}
      </div>

      {!plot && !greeting && (
        <div className="absolute left-3 right-[4.25rem] top-[calc(env(safe-area-inset-top,0px)+7.25rem)] sm:right-auto sm:bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] sm:top-auto sm:w-[340px]">
          <div className={`pointer-events-auto ${PANEL} rounded-[22px_18px_22px_20px] p-3`} data-testid="garden-visit-note">
            <p className="text-[12px] leading-relaxed text-[#EEF3FF]/85">
              {island.protection.active
                ? takeReasonText(island.protection.reason, island.protection.until)
                : !island.standing.canTake
                  ? takeReasonText(island.standing.reason, island.standing.availableAt)
                  : ripe > 0
                    ? `Có ${ripe} cây chín bạn có thể lấy một ít. Chạm vào luống để xem.`
                    : "Chưa có cây chín nào lấy được lúc này. Bạn vẫn có thể dạo quanh đảo."}
            </p>
            {island.standing.canTake && <p className="mt-1 text-[11px] text-[#EEF3FF]/55">Bạn còn {island.standing.takesLeft} lần “Lấy một ít” trong 24 giờ.</p>}
          </div>
        </div>
      )}

      <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+4.75rem)] left-3 flex gap-2 sm:bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
        <ActionButton tone="care" className="pointer-events-auto h-12" onClick={onHome} testId="garden-visit-home">
          <Home className="h-4 w-4" aria-hidden />Về đảo của tôi
        </ActionButton>
        <button type="button" onClick={onOpenSocial} data-testid="garden-visit-islands" aria-label="Mở Quần đảo bạn bè"
          className={`pointer-events-auto ${PANEL} inline-flex h-12 w-12 items-center justify-center rounded-[18px_14px_18px_16px] text-[#EEF3FF]/85 transition-transform duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer`}>
          <Compass className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" onClick={() => setGreeting((g) => !g)} data-testid="garden-visit-greet" aria-pressed={greeting} aria-label="Gửi lời nhắn tới chủ đảo"
          className={`pointer-events-auto ${PANEL} inline-flex h-12 w-12 items-center justify-center rounded-[18px_14px_18px_16px] text-[#EEF3FF]/85 transition-transform duration-200 ${EASE} active:scale-[0.96] ${FOCUS_RING} cursor-pointer`}>
          <MessageCircleHeart className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {greeting && !plot && (
        <GardenSheet labelledBy="garden-greet-title" onClose={() => setGreeting(false)} testId="garden-visit-greeting">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold text-[#9cefe0]">Tới {island.owner.name}</p>
              <h2 id="garden-greet-title" className="mt-0.5 text-lg font-black text-[#EEF3FF]">Gửi một lời nhắn</h2>
            </div>
            <CloseButton onClose={() => setGreeting(false)} label="Đóng lời nhắn" />
          </div>
          {island.myReaction ? (
            <p className="mt-3 text-[13px] leading-relaxed text-[#EEF3FF]/80">
              Bạn đã gửi: “{REACTION_LABEL[island.myReaction] ?? "một lời chào"}”.{island.reactionAvailableAt ? ` Bạn có thể gửi lời nhắn mới lúc ${momentText(island.reactionAvailableAt)}.` : ""}
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {reactions.filter((code) => REACTION_LABEL[code]).map((code) => (
                <ActionButton key={code} tone="quiet" className="w-full justify-start text-left" disabled={social.busy !== null}
                  testId={`garden-greet-${code}`} onClick={() => void social.react(code)}>
                  {REACTION_LABEL[code]}
                </ActionButton>
              ))}
              <p className="text-[11px] leading-relaxed text-[#EEF3FF]/50">Mỗi ngày một lời nhắn cho mỗi đảo. Chỉ có các câu soạn sẵn, không có trò chuyện tự do.</p>
            </div>
          )}
        </GardenSheet>
      )}

      {plot && <VisitPlotCard island={island} plot={plot} social={social} serverNowMs={social.serverNow()} onClose={onCloseSelection} />}
    </div>
  );
}
