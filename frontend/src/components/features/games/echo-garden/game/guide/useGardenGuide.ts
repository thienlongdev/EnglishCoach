"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GardenGuide } from "@/types/garden";
import type { GardenSceneApi, TimeOfDay } from "../../EchoGardenCanvas";
import type { EchoGardenGame } from "../useEchoGarden";
import type { Box } from "./guideGeometry";
import { STARTER, STARTER_FAREWELL, STARTER_ID, plotBySlot, topicById, type GuideCtx, type GuideExpect, type GuideStep, type GuideTopic } from "./guideScripts";

/**
 * Echo guide — the voluntary, account-scoped tutorial of Echo Garden (client side).
 *
 * The SERVER owns the record (`state.guide`): whether this garden may be offered the guide, what its owner decided and
 * how far the starter guide came. This hook only presents it:
 *   - the invitation is shown at most once per account: only when the server says `invite`, only after the island is
 *     the player's to touch, and showing it is reported at once so no later visit can offer it again;
 *   - a visit that finds an unanswered invitation or an unfinished guide settles it quietly (declined / left) and
 *     never reopens it — the player continues from Help when they wish;
 *   - a step is finished by the player's OWN action as the game confirmed it (a bed selected in the scene, a planting
 *     or a watering the server accepted). The guide sends no game command, grants nothing and polls nothing.
 */
export interface GuideControls {
  game: EchoGardenGame;
  /** the player's own garden is on screen and playable */
  home: boolean;
  /** the entry reveal is over: nothing covers the island */
  ready: boolean;
  scene: GardenSceneApi | null;
  /** a panel is open (any) / the bed whose sheet is open */
  panelOpen: boolean;
  openSlot: number | null;
  timeOfDay: TimeOfDay;
  /** a payment, reward or quiz surface is open: the guide steps aside and never covers it */
  sensitive: boolean;
  closePanels: () => void;
  focus: (id: string) => void;
  goHome: () => void;
  openHelp: () => void;
}

export interface GuideRun {
  topic: GuideTopic;
  index: number;
  starter: boolean;
  /** the starter guide's last word (after its seventh milestone) */
  farewell: boolean;
}

const INVITED_KEY = "echo-garden:guide-invited";

/** This device already showed the invitation to the signed-in account (storage is cleared on every account switch). */
function invitedHere(): boolean {
  try {
    return window.localStorage.getItem(INVITED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberInvited() {
  try {
    window.localStorage.setItem(INVITED_KEY, "1");
  } catch {
    /* the server record is the authority */
  }
}

export function useGardenGuide(c: GuideControls) {
  const { game, home, ready, scene, openSlot, timeOfDay } = c;
  const state = game.state;
  const record: GardenGuide | null = state?.guide ?? null;
  const [invite, setInvite] = useState(false);
  const [run, setRunState] = useState<GuideRun | null>(null);
  // the run as of this instant (two confirmations in one tick must not advance twice; no effect inside an updater)
  const runRef = useRef<GuideRun | null>(null);
  const setRun = useCallback((next: GuideRun | null) => {
    runRef.current = next;
    setRunState(next);
  }, []);
  const controls = useRef(c);
  controls.current = c;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const guideAction = game.guideAction;

  // ------------------------------------------------------------------ the one-time invitation
  const settled = useRef(false);
  const hasRecord = record !== null;
  useEffect(() => {
    if (!home || !ready || !hasRecord || settled.current) return;
    const g = controls.current.game.state?.guide;
    const step = controls.current.game.state?.onboardingStep ?? 8;
    if (!g) return;
    settled.current = true;
    if (g.invite && !invitedHere()) {
      setInvite(true);
      return;
    }
    // an offer left unanswered, a guide left running, or a garden from before the guide: settle it and play on
    if (g.invite || g.status === "INVITED" || g.status === "STARTED" || (g.status === null && step < 8)) void guideAction("SETTLE");
  }, [home, ready, hasRecord, guideAction]);

  const shownSent = useRef(false);
  /** Called by the invitation once it is really on screen: from now on it can never be offered again. */
  const inviteShown = useCallback(() => {
    if (shownSent.current) return;
    shownSent.current = true;
    rememberInvited();
    void guideAction("SHOWN");
  }, [guideAction]);

  // ------------------------------------------------------------------ running a guide
  const start = useCallback((topicId: string, mode: "resume" | "restart" = "restart") => {
    const topic = topicById(topicId);
    if (!topic) return;
    const starter = topicId === STARTER_ID;
    let index = 0;
    if (starter) {
      const g = controls.current.game.state?.guide;
      if (mode === "resume" && g && (g.status === "STARTED" || g.status === "EXITED")) index = Math.min(g.step, STARTER.length - 1);
      void guideAction("START");
    }
    setInvite(false);
    setRun({ topic, index, starter, farewell: false });
  }, [guideAction, setRun]);

  const acceptInvite = useCallback(() => start(STARTER_ID, "restart"), [start]);
  const declineInvite = useCallback(() => {
    setInvite(false);
    void guideAction("DECLINE");
  }, [guideAction]);

  /** Leave the guide now. A starter guide left halfway keeps its place for "Tiếp tục hướng dẫn". */
  const exit = useCallback(() => {
    const r = runRef.current;
    if (!r) return;
    if (r.starter && !r.farewell) void guideAction("EXIT");
    setRun(null);
  }, [guideAction, setRun]);

  /** One step forward: by "Tiếp tục", by "Bỏ qua bước này", or because the player's own action was confirmed. */
  const advance = useCallback(() => {
    const r = runRef.current;
    if (!r || r.farewell) return;
    const last = r.index >= r.topic.steps.length - 1;
    if (r.starter && last) {
      void guideAction("COMPLETE");
      setRun({ ...r, farewell: true });
    } else if (last) {
      setRun(null);
    } else {
      if (r.starter) void guideAction("PROGRESS", r.index + 1);
      setRun({ ...r, index: r.index + 1 });
    }
  }, [guideAction, setRun]);

  const back = useCallback(() => {
    const r = runRef.current;
    if (r && !r.farewell && r.index > 0) setRun({ ...r, index: r.index - 1 });
  }, [setRun]);

  /** The last card of a guide: play, or look at the other guides. */
  const finish = useCallback((toHelp: boolean) => {
    setRun(null);
    if (toHelp) controls.current.openHelp();
  }, [setRun]);

  // what the current step says, points at and waits for — recomputed from the live server state
  const ctx: GuideCtx | null = useMemo(() => (state ? { state, openSlot } : null), [state, openSlot]);
  const step: GuideStep | null = run && !run.farewell ? run.topic.steps[run.index] ?? null : null;
  const target = step && ctx ? step.target(ctx) : null;
  const expect: GuideExpect = step && ctx ? step.expect(ctx) : "next";
  const text = run?.farewell ? STARTER_FAREWELL : step && ctx ? step.text(ctx) : "";
  const targetRef = useRef<string | null>(null);
  targetRef.current = target;

  // a step arranges the picture once, when it starts (panels away, camera home or on the place); never afterwards
  const stepKey = run ? `${run.topic.id}:${run.farewell ? "end" : run.index}` : "";
  useEffect(() => {
    if (!stepKey) return;
    const r = runRef.current;
    const s = r && !r.farewell ? r.topic.steps[r.index] : null;
    const live = controls.current;
    const st = live.game.state;
    if (!s?.arrange || !st) return;
    if (s.arrange.closePanels) live.closePanels();
    if (s.arrange.home) live.goHome();
    const place = s.arrange.focus?.({ state: st, openSlot: live.openSlot });
    if (place) live.focus(place);
  }, [stepKey]);

  // the player's own selection of a free bed finishes "find a bed" (any free bed counts, not one chosen for them)
  useEffect(() => {
    if (expect !== "plot" || !state || openSlot === null) return;
    const p = plotBySlot(state, openSlot);
    if (p && !p.planting) advance();
  }, [expect, openSlot, state, advance]);

  // a change of the time of day finishes "try another time" once the sky has had time to turn
  const timeAtStep = useRef(timeOfDay);
  useEffect(() => {
    timeAtStep.current = controls.current.timeOfDay;
  }, [stepKey]);
  useEffect(() => {
    if (expect !== "time" || timeOfDay === timeAtStep.current) return;
    const id = window.setTimeout(advance, 3000);
    return () => window.clearTimeout(id);
  }, [expect, timeOfDay, advance]);

  /** The game reports an action the SERVER accepted (never a tap, never a guess). */
  const expectRef = useRef(expect);
  expectRef.current = expect;
  const notify = useCallback((event: "planted" | "watered") => {
    if (runRef.current && expectRef.current === event) advance();
  }, [advance]);

  // the guide steps aside: another island, a payment / reward / quiz surface, or a panel opened during a free step
  const aside = !!run && (!home || c.sensitive || (!!step?.free && c.panelOpen));
  useEffect(() => {
    if (aside) exit();
  }, [aside, exit]);
  useEffect(() => {
    if (!home) setInvite(false);
  }, [home]);

  /**
   * Where the current target is on screen right now (client px), or null. Called by the layer, never stored.
   * A control inside a scrolling sheet is brought into view once per step and then shown as the part of it that is
   * really visible (never a box drawn over the sheet's edge or below the screen).
   */
  const scrollers = useRef(new WeakMap<Element, HTMLElement[]>());
  const broughtIn = useRef("");
  const stepKeyRef = useRef(stepKey);
  stepKeyRef.current = stepKey;
  const resolveTarget = useCallback((): Box | null => {
    const t = targetRef.current;
    if (!t || typeof document === "undefined") return null;
    if (t.startsWith("world:")) return sceneRef.current?.targetClientRect(t.slice(6)) ?? null;
    const nodes = document.querySelectorAll<HTMLElement>(`[data-guide="${t.slice(4)}"]`);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width <= 4 || r.height <= 4) continue;
      let clips = scrollers.current.get(el);
      if (!clips) {
        clips = [];
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = window.getComputedStyle(p).overflowY;
          if (o === "auto" || o === "scroll") clips.push(p);
        }
        scrollers.current.set(el, clips);
      }
      let x0 = r.left, y0 = r.top, x1 = r.right, y1 = Math.min(r.bottom, window.innerHeight);
      for (const c of clips) {
        const q = c.getBoundingClientRect();
        x0 = Math.max(x0, q.left);
        y0 = Math.max(y0, q.top);
        x1 = Math.min(x1, q.right);
        y1 = Math.min(y1, q.bottom);
      }
      const key = `${stepKeyRef.current}|${t}`;
      if (broughtIn.current !== key && y1 - y0 < Math.min(r.height, 120) - 1) {
        broughtIn.current = key;
        el.scrollIntoView({ block: r.height > window.innerHeight * 0.5 ? "nearest" : "center", inline: "nearest" });
        return null;
      }
      if (x1 - x0 < 4 || y1 - y0 < 4) return null;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return null;
  }, []);

  /** Bring the camera to a world target the player moved away from. */
  const bringIntoView = useCallback(() => {
    const t = targetRef.current;
    if (t?.startsWith("world:")) controls.current.focus(t.slice(6) === "island" ? "farm_zone" : t.slice(6));
  }, []);

  return {
    record, invite, inviteShown, acceptInvite, declineInvite,
    run, step, text, target, expect, stepKey,
    start, advance, back, exit, finish, notify, resolveTarget, bringIntoView,
  };
}

export type GardenGuideApi = ReturnType<typeof useGardenGuide>;
