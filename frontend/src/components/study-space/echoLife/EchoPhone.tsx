'use client';
/**
 * Echo Life Wave 11 — Echo Phone Smartphone Hub (9 Integrated Apps).
 * Docked 370x640 smartphone interface: Messages (22 residents + hangout invites),
 * Campus Feed, Careers (7 active shifts + 4 full-time tracks + Workplace Dilemma modal),
 * Pocket Market (10 home recipes + 5 Willow Bistro items), Schedule, Transit (6 shuttle stops + vehicles),
 * Karma and 8 Sub-Skills, Echo Bank ledger, and Photo Studio Gallery.
 * 100% clean English copy, pure multi-stop Pearl Opal glass over WebGL, zero V3 edits.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Award,
  BatteryCharging,
  Briefcase,
  Bus,
  Calendar,
  Car,
  ChevronLeft,
  Coffee,
  Download,
  Globe,
  Heart,
  Image as ImageIcon,
  MapPin,
  MessageSquare,
  Send,
  ShoppingBag,
  Trash2,
  Utensils,
  Wallet,
  Wifi,
  X,
} from 'lucide-react';
import portraits from '@/lib/echo-life/game/portraits.json';
import jobsData from '@/lib/echo-life/game/jobs.json';
import {
  BUS_STOPS,
  RESIDENT_CONTACTS,
  SEASONAL_FESTIVALS,
  SHUTTLE_STANDARD_FARE,
  createPlayerFeedPost,
  deletePhotoThumb,
  getBankSummary,
  getDailySchedule,
  likeFeedPost,
  loadPhotoThumb,
  planBusTrip,
  replyToFeedPost,
  sendHangoutInvite,
  sendResidentMessage,
  type BusStop,
  type BusStopId,
  type BusTripPlan,
  type EchoPhoneState,
  type FeedMilestoneTag,
  type HangoutMeetupPlan,
  type HangoutVenue,
  type PhonePhotoMeta,
} from '@/lib/echo-life/game/phoneSim';
import {
  FULL_TIME_CAREERS,
  completeFullTimeWorkday,
  enrollFullTimeCareer,
  getAllPartTimeStatuses,
  getFullTimeCareer,
  pickWorkplaceDilemma,
  resolveWorkplaceDilemma,
  type DilemmaResolutionResult,
  type FullTimeCareerId,
  type FullTimeCareerState,
  type PartTimeJobId,
  type WorkplaceDilemma,
} from '@/lib/echo-life/game/careerSim';
import {
  BISTRO_MENU,
  INGREDIENT_LABELS,
  listCookableRecipes,
  type CookingInventory,
  type IngredientId,
} from '@/lib/echo-life/game/cookingSim';
import {
  SUB_SKILL_CATALOG,
  SUB_SKILL_IDS,
  SUB_SKILL_THRESHOLDS,
  applyKarmaDelta,
  type KarmaTier,
  type PlayerMindState,
} from '@/lib/echo-life/game/playerMind';
import type { ResidentId } from '@/lib/echo-life/game/npcMind';
import { cleanDisplayCopy } from '@/lib/echo-life/game/session';
import s from './echoPhone.module.css';

export type EchoPhoneAppId =
  | 'home'
  | 'messages'
  | 'feed'
  | 'careers'
  | 'market'
  | 'schedule'
  | 'transit'
  | 'karma'
  | 'bank'
  | 'gallery';

export interface PhoneResidentMeta {
  id: ResidentId;
  zone?: string;
  zoneLabel?: string;
  mood?: string;
  friendship: number;
  online?: boolean;
}

export interface PhoneOwnedVehicle {
  instanceId: string;
  name: string;
  kind: 'car' | 'bike' | 'motorbike';
  active?: boolean;
  locationLabel?: string;
}

export interface EchoPhoneProps {
  open: boolean;
  initialApp?: EchoPhoneAppId;
  accountKey?: string;
  playerName?: string;
  day: number;
  weekdayIndex: number;
  seasonIndex: 0 | 1 | 2 | 3;
  clock: number;
  timeLabel: string;
  weatherLabel: string;
  rain?: boolean;
  snow?: boolean;
  credits: number;
  ownedAssetValue?: number;
  playerZone?: string;
  phoneState: EchoPhoneState;
  onPhoneStateChange: (next: EchoPhoneState) => void;
  mindState: PlayerMindState;
  onMindStateChange?: (next: PlayerMindState) => void;
  careerState: FullTimeCareerState;
  onCareerStateChange?: (next: FullTimeCareerState) => void;
  shiftCounts?: Partial<Record<PartTimeJobId, number>>;
  activeShiftJobId?: PartTimeJobId | null;
  residents?: Partial<Record<ResidentId, PhoneResidentMeta>>;
  cookingInventory?: CookingInventory;
  cookingLevel?: number;
  bistroOpen?: boolean;
  marketOpen?: boolean;
  flashSaleActive?: boolean;
  busStops?: readonly BusStop[];
  nearestBusStopId?: BusStopId | null;
  ownedVehicles?: readonly PhoneOwnedVehicle[];
  onTrackShift?: (jobId: PartTimeJobId) => void;
  onStartFullTimeWorkday?: (careerId: FullTimeCareerId) => void;
  onResolveDilemma?: (result: DilemmaResolutionResult) => void;
  onHangoutAccepted?: (plan: HangoutMeetupPlan) => void;
  onBoardShuttle?: (trip: BusTripPlan) => void;
  onSetWaypoint?: (zone: string, label: string, pos?: { x: number; y: number; z: number }) => void;
  onSummonVehicle?: (instanceId: string) => void;
  onNotify?: (message: string, tone?: 'good' | 'bad' | 'story') => void;
  onClose: () => void;
}

const SEASON_LABELS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
const KARMA_TIERS: readonly KarmaTier[] = [
  'Rebellious',
  'Mischievous',
  'Steady Neighbor',
  'Kind Heart',
  'Radiant Citizen',
];

const QUICK_REPLIES = [
  'Want to grab coffee soon?',
  'How is the weather over there?',
  'Taking a quick study break!',
  'Hope your work is going smoothly!',
] as const;

const FEED_QUICK_REPLIES = [
  'Love this update!',
  'See you around Riverside soon!',
  'Count me in next time!',
] as const;

const HANGOUT_OPTIONS: readonly { venue: HangoutVenue; label: string }[] = [
  { venue: 'bistro', label: 'Willow Bistro' },
  { venue: 'park', label: 'Riverside Park' },
  { venue: 'home', label: 'My Home' },
];

const APP_TILES: readonly {
  id: Exclude<EchoPhoneAppId, 'home'>;
  label: string;
  bg: string;
  Icon: typeof MessageSquare;
}[] = [
  { id: 'messages', label: 'Messages', bg: 'linear-gradient(135deg, #0284c7, #38bdf8)', Icon: MessageSquare },
  { id: 'feed', label: 'Campus Feed', bg: 'linear-gradient(135deg, #2563eb, #6366f1)', Icon: Globe },
  { id: 'careers', label: 'Careers', bg: 'linear-gradient(135deg, #d97706, #f59e0b)', Icon: Briefcase },
  { id: 'market', label: 'Pocket Market', bg: 'linear-gradient(135deg, #059669, #10b981)', Icon: ShoppingBag },
  { id: 'schedule', label: 'Schedule', bg: 'linear-gradient(135deg, #e11d48, #fb7185)', Icon: Calendar },
  { id: 'transit', label: 'Transit', bg: 'linear-gradient(135deg, #0d9488, #2dd4bf)', Icon: Bus },
  { id: 'karma', label: 'Karma', bg: 'linear-gradient(135deg, #7c3aed, #a78bfa)', Icon: Award },
  { id: 'bank', label: 'Echo Bank', bg: 'linear-gradient(135deg, #b45309, #eab308)', Icon: Wallet },
  { id: 'gallery', label: 'Gallery', bg: 'linear-gradient(135deg, #0369a1, #14b8a6)', Icon: ImageIcon },
];

const JOBS_BY_ID = jobsData as unknown as Record<
  string,
  { title: string; steps: (string | string[])[][] }
>;

function portraitStyle(residentId: string): React.CSSProperties | undefined {
  const idx = portraits.speakers.indexOf(residentId);
  if (idx < 0) return undefined;
  return {
    backgroundImage: `url(${portraits.image})`,
    backgroundSize: `${portraits.columns * 100}% ${portraits.rows * 100}%`,
    backgroundPosition: `${((idx % portraits.columns) * 100) / (portraits.columns - 1)}% ${
      (Math.floor(idx / portraits.columns) * 100) / (portraits.rows - 1)
    }%`,
  };
}

function formatClock(clock: number): string {
  const mins = ((Math.floor(clock) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function EchoPhone({
  open,
  initialApp = 'home',
  accountKey = 'local',
  playerName = 'You',
  day,
  weekdayIndex,
  seasonIndex,
  clock,
  timeLabel,
  weatherLabel,
  rain = false,
  snow = false,
  credits,
  ownedAssetValue = 0,
  playerZone = 'street',
  phoneState,
  onPhoneStateChange,
  mindState,
  onMindStateChange,
  careerState,
  onCareerStateChange,
  shiftCounts = {},
  activeShiftJobId = null,
  residents = {},
  cookingInventory = {},
  cookingLevel,
  bistroOpen = true,
  marketOpen = true,
  flashSaleActive = false,
  busStops,
  nearestBusStopId = null,
  ownedVehicles = [],
  onTrackShift,
  onStartFullTimeWorkday,
  onResolveDilemma,
  onHangoutAccepted,
  onBoardShuttle,
  onSetWaypoint,
  onSummonVehicle,
  onNotify,
  onClose,
}: EchoPhoneProps) {
  const [app, setApp] = useState<EchoPhoneAppId>(initialApp);
  const [contactSearch, setContactSearch] = useState('');
  const [activeContactId, setActiveContactId] = useState<ResidentId | null>(null);
  const [chatDraft, setChatDraft] = useState('');
  const [feedDraft, setFeedDraft] = useState('');
  const [feedTag, setFeedTag] = useState<FeedMilestoneTag>('daily_note');
  const [careerTab, setCareerTab] = useState<'shifts' | 'fulltime'>('shifts');
  const [marketTab, setMarketTab] = useState<'recipes' | 'bistro'>('recipes');
  const [activeDilemma, setActiveDilemma] = useState<WorkplaceDilemma | null>(null);
  const [dilemmaResult, setDilemmaResult] = useState<DilemmaResolutionResult | null>(null);
  const [originStopId, setOriginStopId] = useState<BusStopId>(nearestBusStopId ?? 'lantern_street');
  const [selectedPhoto, setSelectedPhoto] = useState<PhonePhotoMeta | null>(null);

  useEffect(() => {
    if (open) {
      setApp(initialApp);
      setActiveDilemma(null);
      setDilemmaResult(null);
      setSelectedPhoto(null);
    }
  }, [open, initialApp]);

  useEffect(() => {
    if (nearestBusStopId) setOriginStopId(nearestBusStopId);
  }, [nearestBusStopId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (activeDilemma || dilemmaResult) {
        setActiveDilemma(null);
        setDilemmaResult(null);
      } else if (selectedPhoto) {
        setSelectedPhoto(null);
      } else if (app === 'messages' && activeContactId) {
        setActiveContactId(null);
      } else if (app !== 'home') {
        setApp('home');
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, activeDilemma, dilemmaResult, selectedPhoto, app, activeContactId, onClose]);

  const effectiveCookingLevel = cookingLevel ?? mindState.subSkills.cooking.level ?? 1;
  const stops = busStops && busStops.length > 0 ? busStops : BUS_STOPS;

  const partTimeStatuses = useMemo(() => getAllPartTimeStatuses(shiftCounts), [shiftCounts]);
  const recipes = useMemo(
    () => listCookableRecipes(cookingInventory, effectiveCookingLevel),
    [cookingInventory, effectiveCookingLevel],
  );
  const scheduleEntries = useMemo(
    () =>
      getDailySchedule(phoneState, day, {
        seasonIndex,
        weekdayIndex,
        fullTimeCareerId: careerState.activeCareerId,
      }),
    [phoneState, day, seasonIndex, weekdayIndex, careerState.activeCareerId],
  );
  const bankSummary = useMemo(
    () => getBankSummary(phoneState, credits, ownedAssetValue),
    [phoneState, credits, ownedAssetValue],
  );

  const filteredContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    return RESIDENT_CONTACTS.filter(
      c => !q || c.name.toLowerCase().includes(q) || c.role.toLowerCase().includes(q),
    );
  }, [contactSearch]);

  if (!open) return null;

  const activeContact = activeContactId
    ? RESIDENT_CONTACTS.find(c => c.id === activeContactId) ?? null
    : null;
  const activeContactMeta = activeContactId ? residents[activeContactId] : undefined;
  const activeThread = activeContactId ? phoneState.threads[activeContactId] ?? [] : [];

  const handleSendText = (text: string) => {
    if (!activeContactId || !text.trim()) return;
    const meta = residents[activeContactId];
    const res = sendResidentMessage(phoneState, activeContactId, text, {
      friendship: meta?.friendship ?? 15,
      npcZone: meta?.zoneLabel ?? meta?.zone,
      npcMood: meta?.mood,
      weatherLabel,
      rain,
      snow,
      day,
      clock,
    });
    onPhoneStateChange(res.state);
    setChatDraft('');
  };

  const handleInviteHangout = (venue: HangoutVenue) => {
    if (!activeContactId) return;
    const meta = residents[activeContactId];
    const res = sendHangoutInvite(phoneState, activeContactId, venue, {
      friendship: meta?.friendship ?? 25,
      npcZone: meta?.zoneLabel ?? meta?.zone,
      npcMood: meta?.mood,
      weatherLabel,
      rain,
      snow,
      day,
      clock,
    });
    onPhoneStateChange(res.state);
    if (res.accepted && res.meetupPlan) {
      onHangoutAccepted?.(res.meetupPlan);
      onNotify?.(`Hangout confirmed with ${res.meetupPlan.npcName} at ${res.meetupPlan.venueLabel}.`, 'good');
    } else {
      onNotify?.(res.replyText, 'story');
    }
  };

  const handleCreatePost = () => {
    if (!feedDraft.trim()) return;
    const res = createPlayerFeedPost(phoneState, feedDraft, feedTag, day, clock, playerName, playerZone);
    if (!res.post) return;
    onPhoneStateChange(res.state);
    setFeedDraft('');
    onNotify?.('Shared update on Campus Feed.', 'good');
  };

  const handleLikePost = (postId: string) => {
    const res = likeFeedPost(phoneState, postId);
    onPhoneStateChange(res.state);
  };

  const handleReplyPost = (postId: string, text: string) => {
    const res = replyToFeedPost(phoneState, postId, text, day, clock, playerName);
    if (res.ok) onPhoneStateChange(res.state);
  };

  const handleEnrollCareer = (careerId: FullTimeCareerId) => {
    const next = enrollFullTimeCareer(careerState, careerId);
    onCareerStateChange?.(next);
    const track = getFullTimeCareer(careerId);
    if (track) onNotify?.(`Enrolled as ${track.ranks[0].title} (${track.title}).`, 'good');
  };

  const handleCompleteWorkday = (careerId: FullTimeCareerId) => {
    const res = completeFullTimeWorkday(careerState, day);
    if (!res.ok) {
      onNotify?.(res.reason, 'bad');
      return;
    }
    onCareerStateChange?.(res.state);
    onStartFullTimeWorkday?.(careerId);
    onNotify?.(res.reason, 'good');
  };

  const handleOpenDilemma = (careerId: FullTimeCareerId) => {
    const dilemma = pickWorkplaceDilemma(careerId, day, 517 + day, careerState.resolvedDilemmaIds);
    if (!dilemma) return;
    setDilemmaResult(null);
    setActiveDilemma(dilemma);
  };

  const handleChooseDilemma = (choiceId: string) => {
    if (!activeDilemma) return;
    const res = resolveWorkplaceDilemma(careerState, activeDilemma.id, choiceId, day);
    if (!res.ok) return;
    onCareerStateChange?.(res.state);
    if (onMindStateChange && res.deltas.karmaDelta !== 0) {
      onMindStateChange({
        ...mindState,
        karma: applyKarmaDelta(
          mindState.karma,
          res.deltas.karmaDelta,
          Math.round(res.deltas.karmaDelta * 0.45),
          activeDilemma.title,
          day,
          clock,
          'workplace_dilemma',
        ),
      });
    }
    onResolveDilemma?.(res);
    setDilemmaResult(res);
  };

  const handleBoardStop = (toStopId: BusStopId) => {
    const trip = planBusTrip(originStopId, toStopId, credits, phoneState.hasStudentPass);
    if (!trip.ok) {
      onNotify?.(trip.reason, 'bad');
      return;
    }
    onBoardShuttle?.(trip);
    onNotify?.(trip.reason, 'good');
  };

  const handleDeletePhoto = (photo: PhonePhotoMeta) => {
    deletePhotoThumb(accountKey, photo.thumbKey);
    onPhoneStateChange({
      ...phoneState,
      photos: phoneState.photos.filter(p => p.id !== photo.id),
    });
    if (selectedPhoto?.id === photo.id) setSelectedPhoto(null);
    onNotify?.('Removed photo from Echo Phone Gallery.', 'story');
  };

  const unreadMessagesCount = Object.values(phoneState.threads).reduce(
    (sum, msgs) => sum + (msgs && msgs.length > 0 && msgs[msgs.length - 1].sender !== 'player' ? 1 : 0),
    0,
  );

  const activeAppTitle =
    app === 'messages' ? (activeContact ? activeContact.name : 'Messages')
    : app === 'feed' ? 'Campus Feed'
    : app === 'careers' ? 'Careers'
    : app === 'market' ? 'Pocket Market'
    : app === 'schedule' ? 'Schedule'
    : app === 'transit' ? 'Transit'
    : app === 'karma' ? 'Karma and Sub-Skills'
    : app === 'bank' ? 'Echo Bank'
    : app === 'gallery' ? 'Gallery'
    : 'Echo Phone';

  const activeFullTime = getFullTimeCareer(careerState.activeCareerId);
  const selectedPhotoDataUrl = selectedPhoto ? loadPhotoThumb(accountKey, selectedPhoto.thumbKey) : null;

  return (
    <aside
      className={s.phoneShell}
      role="dialog"
      aria-label="Echo Phone"
      data-testid="echo-phone"
    >
      <div className={s.screen}>
        {/* Status Bar */}
        <div className={s.statusBar}>
          <div className={s.statusLeft}>
            <span>{timeLabel}</span>
            <span className={s.pill}>{weatherLabel}</span>
          </div>
          <span className={s.speakerPill} aria-hidden="true" />
          <div className={s.statusRight}>
            <Wifi size={12} aria-hidden="true" />
            <BatteryCharging size={13} aria-hidden="true" />
            <button
              type="button"
              className={s.closePhoneBtn}
              aria-label="Close Echo Phone"
              data-testid="echo-phone-close"
              onClick={onClose}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Sub-App Back Header */}
        {app !== 'home' && (
          <header className={s.appHeader}>
            <button
              type="button"
              className={s.backBtn}
              data-testid="echo-phone-back"
              onClick={() => {
                if (app === 'messages' && activeContactId) setActiveContactId(null);
                else setApp('home');
              }}
            >
              <ChevronLeft size={14} aria-hidden="true" />
              <span>{app === 'messages' && activeContactId ? 'Contacts' : 'Home'}</span>
            </button>
            <h2 className={s.appTitle}>{activeAppTitle}</h2>
            <span className={s.pillGold}>{credits} CC</span>
          </header>
        )}

        <div className={s.body}>
          {/* ── HOME SCREEN (3x3 APP GRID) ─────────────────────────────────────────────────────────────── */}
          {app === 'home' && (
            <>
              <div className={s.homeHero}>
                <div className={s.homeHeroRow}>
                  <span className={s.homeClock}>{timeLabel}</span>
                  <span className={s.homeCredits}>{credits} CC</span>
                </div>
                <div className={s.homeMeta}>
                  <span>Day {day + 1} · {SEASON_LABELS[seasonIndex]}</span>
                  <span>·</span>
                  <span>{mindState.karma.tier}</span>
                  {activeShiftJobId && <span className={s.pillGold}>Shift Active</span>}
                </div>
              </div>

              <div className={s.appGrid} role="grid" aria-label="Echo Phone applications">
                {APP_TILES.map(({ id, label, bg, Icon }) => {
                  const badge =
                    id === 'messages' && unreadMessagesCount > 0 ? unreadMessagesCount
                    : id === 'schedule' && scheduleEntries.length > 0 ? scheduleEntries.length
                    : id === 'gallery' && phoneState.photos.length > 0 ? phoneState.photos.length
                    : 0;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={s.appTile}
                      data-testid={`phone-app-${id}`}
                      onClick={() => setApp(id)}
                    >
                      <span className={s.appIconBox} style={{ background: bg }}>
                        <Icon size={20} aria-hidden="true" />
                      </span>
                      <span className={s.appTileLabel}>{label}</span>
                      {badge > 0 && <span className={s.tileBadge}>{badge}</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {/* ── APP 1: MESSAGES (22 RESIDENTS + HANGOUT INVITE) ────────────────────────────────────────── */}
          {app === 'messages' && !activeContact && (
            <>
              <input
                type="search"
                className={s.input}
                placeholder="Search 22 Riverside residents..."
                value={contactSearch}
                aria-label="Search residents"
                data-testid="phone-messages-search"
                onChange={e => setContactSearch(e.target.value)}
              />
              {filteredContacts.map(contact => {
                const meta = residents[contact.id];
                const thread = phoneState.threads[contact.id] ?? [];
                const lastMsg = thread[thread.length - 1];
                const hasUnread = Boolean(lastMsg && lastMsg.sender !== 'player');
                return (
                  <button
                    key={contact.id}
                    type="button"
                    className={s.contactRow}
                    data-testid={`phone-contact-${contact.id}`}
                    onClick={() => setActiveContactId(contact.id)}
                  >
                    <span className={s.avatarSprite} style={portraitStyle(contact.id)} aria-hidden="true" />
                    <div className={s.contactMeta}>
                      <div className={s.contactNameRow}>
                        <strong>{contact.name}</strong>
                        <span className={s.rowWrap}>
                          <span className={s.pillAccent}>
                            <Heart size={10} aria-hidden="true" /> {Math.round(meta?.friendship ?? 15)}
                          </span>
                          {hasUnread && <span className={s.pillGood}>New</span>}
                        </span>
                      </div>
                      <span className={s.contactPreview}>
                        {lastMsg ? lastMsg.text : `${contact.role} · ${meta?.zoneLabel ?? contact.favoriteZone.replace(/_/g, ' ')}`}
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          )}

          {app === 'messages' && activeContact && (
            <>
              <div className={s.card}>
                <div className={s.rowBetween}>
                  <div className={s.rowWrap}>
                    <span className={s.avatarSprite} style={portraitStyle(activeContact.id)} aria-hidden="true" />
                    <div>
                      <strong>{activeContact.name}</strong>
                      <p className={s.mutedText}>
                        {activeContactMeta?.zoneLabel ?? activeContact.favoriteZone.replace(/_/g, ' ')} · Affinity {Math.round(activeContactMeta?.friendship ?? 15)}
                      </p>
                    </div>
                  </div>
                  <span className={s.pillGood}>{activeContactMeta?.online === false ? 'Busy' : 'Online'}</span>
                </div>
                <div className={s.rowWrap}>
                  <span className={s.pill}>Invite to Hangout:</span>
                  {HANGOUT_OPTIONS.map(opt => (
                    <button
                      key={opt.venue}
                      type="button"
                      className={s.quickChip}
                      data-testid={`phone-invite-${opt.venue}`}
                      onClick={() => handleInviteHangout(opt.venue)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={s.chatStream} data-testid="phone-chat-stream">
                {activeThread.length === 0 && (
                  <p className={s.mutedText}>Start a conversation with {activeContact.name} or send a hangout invite above.</p>
                )}
                {activeThread.map(msg => (
                  <div
                    key={msg.id}
                    className={`${s.bubble} ${msg.sender === 'player' ? s.bubblePlayer : s.bubbleNpc}`}
                  >
                    <div>{msg.text}</div>
                    <small style={{ opacity: 0.72, fontSize: 10 }}>{formatClock(msg.clock)}</small>
                  </div>
                ))}
              </div>

              <div className={s.rowWrap}>
                {QUICK_REPLIES.map(qr => (
                  <button key={qr} type="button" className={s.quickChip} onClick={() => handleSendText(qr)}>
                    {qr}
                  </button>
                ))}
              </div>

              <form
                className={s.chatComposer}
                onSubmit={e => {
                  e.preventDefault();
                  handleSendText(chatDraft);
                }}
              >
                <input
                  type="text"
                  className={s.input}
                  maxLength={140}
                  placeholder={`Message ${activeContact.name}...`}
                  value={chatDraft}
                  aria-label={`Message ${activeContact.name}`}
                  data-testid="phone-chat-input"
                  onChange={e => setChatDraft(e.target.value)}
                />
                <button type="submit" className={s.primaryBtn} aria-label="Send message" data-testid="phone-chat-send">
                  <Send size={13} aria-hidden="true" />
                </button>
              </form>
            </>
          )}

          {/* ── APP 2: CAMPUS FEED ─────────────────────────────────────────────────────────────────────── */}
          {app === 'feed' && (
            <>
              <div className={s.card}>
                <div className={s.rowBetween}>
                  <strong>Share Status</strong>
                  <select
                    className={s.actionBtn}
                    value={feedTag}
                    aria-label="Status category"
                    onChange={e => setFeedTag(e.target.value as FeedMilestoneTag)}
                  >
                    <option value="daily_note">Daily Note</option>
                    <option value="photo_upload">Photo Moment</option>
                    <option value="cooking_feast">Home Cooking</option>
                    <option value="shift_promotion">Career Update</option>
                  </select>
                </div>
                <div className={s.chatComposer}>
                  <input
                    type="text"
                    className={s.input}
                    maxLength={160}
                    placeholder="Share a Riverside moment..."
                    value={feedDraft}
                    aria-label="Share a status update"
                    data-testid="phone-feed-input"
                    onChange={e => setFeedDraft(e.target.value)}
                  />
                  <button type="button" className={s.primaryBtn} data-testid="phone-feed-post" onClick={handleCreatePost}>
                    Post
                  </button>
                </div>
              </div>

              {phoneState.feed.map(post => (
                <article key={post.id} className={s.card} data-testid={`phone-feed-post-${post.id}`}>
                  <div className={s.rowBetween}>
                    <div className={s.rowWrap}>
                      {post.authorId !== 'player' && (
                        <span className={s.avatarSprite} style={portraitStyle(post.authorId)} aria-hidden="true" />
                      )}
                      <div>
                        <strong>{post.authorName}</strong>
                        <p className={s.mutedText}>
                          Day {post.day + 1} · {formatClock(post.clock)}
                          {post.zone ? ` · ${post.zone.replace(/_/g, ' ')}` : ''}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`${s.actionBtn} ${post.likedByPlayer ? s.pillWarn : ''}`}
                      aria-pressed={post.likedByPlayer}
                      onClick={() => handleLikePost(post.id)}
                    >
                      <Heart size={12} aria-hidden="true" /> {post.likes}
                    </button>
                  </div>
                  <p style={{ margin: 0, lineHeight: 1.4 }}>{post.text}</p>
                  {post.comments.length > 0 && (
                    <div style={{ display: 'grid', gap: 4, paddingTop: 4, borderTop: '1px solid var(--ph-border)' }}>
                      {post.comments.map(c => (
                        <p key={c.id} className={s.mutedText}>
                          <strong style={{ color: 'var(--ph-ink)' }}>{c.authorName}:</strong> {c.text}
                        </p>
                      ))}
                    </div>
                  )}
                  <div className={s.rowWrap}>
                    {FEED_QUICK_REPLIES.map(qr => (
                      <button key={qr} type="button" className={s.quickChip} onClick={() => handleReplyPost(post.id, qr)}>
                        {qr}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </>
          )}

          {/* ── APP 3: CAREERS (ACTIVE SHIFTS + FULL-TIME CAREERS + WORKPLACE DILEMMAS) ────────────────── */}
          {app === 'careers' && (
            <>
              <div className={s.segTabs} role="tablist" aria-label="Career tracks">
                <button
                  type="button"
                  role="tab"
                  className={s.segBtn}
                  aria-selected={careerTab === 'shifts'}
                  data-testid="phone-careers-shifts-tab"
                  onClick={() => setCareerTab('shifts')}
                >
                  Active Shifts (7)
                </button>
                <button
                  type="button"
                  role="tab"
                  className={s.segBtn}
                  aria-selected={careerTab === 'fulltime'}
                  data-testid="phone-careers-fulltime-tab"
                  onClick={() => setCareerTab('fulltime')}
                >
                  Full-Time Careers (4)
                </button>
              </div>

              {careerTab === 'shifts' &&
                partTimeStatuses.map(st => {
                  const pct = st.nextTierShifts
                    ? Math.min(100, Math.round((st.completedShifts / st.nextTierShifts) * 100))
                    : 100;
                  const steps = JOBS_BY_ID[st.jobId]?.steps ?? [];
                  return (
                    <div key={st.jobId} className={s.card} data-testid={`phone-shift-${st.jobId}`}>
                      <div className={s.rowBetween}>
                        <strong>{st.title}</strong>
                        <span className={s.pillAccent}>
                          Tier {st.tier} · {st.rankTitle}
                        </span>
                      </div>
                      <div className={s.rowWrap}>
                        <span className={s.pillGold}>{st.effectivePay} CC ({st.payMultiplier.toFixed(2)}x)</span>
                        <span className={s.pill}>{st.completedShifts} shifts done</span>
                        {st.nextTierDef && (
                          <span className={s.pill}>{st.shiftsToNextTier} to {st.nextTierDef.rankTitle}</span>
                        )}
                      </div>
                      <div className={s.progressTrack}>
                        <div className={s.progressFill} style={{ width: `${pct}%` }} />
                      </div>
                      <p className={s.mutedText}>{st.currentTierDef.perkDescription}</p>
                      {steps.length > 0 && (
                        <ol className={s.stepList}>
                          {steps.map((step, i) => (
                            <li key={`${st.jobId}_${i}`}>{String(step[2])}</li>
                          ))}
                        </ol>
                      )}
                      <div className={s.rowBetween}>
                        <span className={s.pillGood}>Unlock: {st.currentTierDef.outfitUnlock}</span>
                        <button
                          type="button"
                          className={s.primaryBtn}
                          data-testid={`phone-track-shift-${st.jobId}`}
                          onClick={() => {
                            onTrackShift?.(st.jobId);
                            onSetWaypoint?.(st.zone, st.title);
                          }}
                        >
                          {activeShiftJobId === st.jobId ? 'Tracking' : 'Track Shift'}
                        </button>
                      </div>
                    </div>
                  );
                })}

              {careerTab === 'fulltime' && (
                <>
                  {activeFullTime && (
                    <div className={s.card} data-testid="phone-active-career">
                      <div className={s.rowBetween}>
                        <strong>{activeFullTime.title}</strong>
                        <span className={s.pillGood}>
                          Rank {careerState.rank} · {activeFullTime.ranks[careerState.rank - 1].title}
                        </span>
                      </div>
                      <p className={s.mutedText}>{activeFullTime.scheduleLabel}</p>
                      <div className={s.rowBetween}>
                        <span className={s.pillGold}>
                          Stipend {activeFullTime.ranks[careerState.rank - 1].dailyStipend} CC
                        </span>
                        <span className={s.pillAccent}>Promotion {careerState.promotionProgress}%</span>
                      </div>
                      <div className={s.progressTrack}>
                        <div className={s.progressFill} style={{ width: `${careerState.promotionProgress}%` }} />
                      </div>
                      <div className={s.rowWrap}>
                        <button
                          type="button"
                          className={s.primaryBtn}
                          disabled={careerState.lastWorkedDay === day}
                          data-testid="phone-workday-btn"
                          onClick={() => handleCompleteWorkday(activeFullTime.id)}
                        >
                          {careerState.lastWorkedDay === day ? 'Workday Done' : 'Complete Workday'}
                        </button>
                        <button
                          type="button"
                          className={s.actionBtn}
                          data-testid="phone-dilemma-btn"
                          onClick={() => handleOpenDilemma(activeFullTime.id)}
                        >
                          Workplace Dilemma
                        </button>
                      </div>
                    </div>
                  )}

                  {FULL_TIME_CAREERS.map(track => {
                    const enrolled = careerState.activeCareerId === track.id;
                    return (
                      <div key={track.id} className={s.card} data-testid={`phone-career-${track.id}`}>
                        <div className={s.rowBetween}>
                          <strong>{track.title}</strong>
                          <span className={s.pill}>{track.mode}</span>
                        </div>
                        <p className={s.mutedText}>{track.summary}</p>
                        <p className={s.mutedText}>{track.scheduleLabel}</p>
                        <div className={s.rowBetween}>
                          <span className={s.pillGold}>Starts at {track.ranks[0].dailyStipend} CC / day</span>
                          <button
                            type="button"
                            className={enrolled ? s.actionBtn : s.primaryBtn}
                            disabled={enrolled}
                            data-testid={`phone-enroll-${track.id}`}
                            onClick={() => handleEnrollCareer(track.id)}
                          >
                            {enrolled ? 'Enrolled' : 'Enroll Track'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}

          {/* ── APP 4: POCKET MARKET (HOME RECIPES + WILLOW BISTRO MENU + HOURS) ───────────────────────── */}
          {app === 'market' && (
            <>
              <div className={s.card}>
                <div className={s.rowWrap}>
                  <span className={marketOpen ? s.pillGood : s.pillWarn}>
                    Sunrise Market: {marketOpen ? 'Open' : 'Closed'}
                  </span>
                  <span className={bistroOpen ? s.pillGood : s.pillWarn}>
                    Willow Bistro: {bistroOpen ? 'Open' : 'Closed'}
                  </span>
                  {flashSaleActive && <span className={s.pillGold}>20% Flash Sale Live</span>}
                </div>
              </div>

              <div className={s.segTabs} role="tablist" aria-label="Pocket Market sections">
                <button
                  type="button"
                  role="tab"
                  className={s.segBtn}
                  aria-selected={marketTab === 'recipes'}
                  data-testid="phone-market-recipes-tab"
                  onClick={() => setMarketTab('recipes')}
                >
                  Home Recipes (10)
                </button>
                <button
                  type="button"
                  role="tab"
                  className={s.segBtn}
                  aria-selected={marketTab === 'bistro'}
                  data-testid="phone-market-bistro-tab"
                  onClick={() => setMarketTab('bistro')}
                >
                  Willow Bistro (5)
                </button>
              </div>

              {marketTab === 'recipes' &&
                recipes.map(({ recipe, eligibility }) => (
                  <div key={recipe.id} className={s.card} data-testid={`phone-recipe-${recipe.id}`}>
                    <div className={s.rowBetween}>
                      <strong>{recipe.name}</strong>
                      <span className={eligibility.ok ? s.pillGood : s.pill}>
                        {eligibility.ok ? 'Ready to Cook' : `Cooking Lv.${recipe.requiredCookingLevel}`}
                      </span>
                    </div>
                    <p className={s.mutedText}>{recipe.description}</p>
                    <div className={s.rowWrap}>
                      {(Object.entries(recipe.ingredients) as [IngredientId, number][]).map(([ing, qty]) => {
                        const have = Math.floor(Number(cookingInventory[ing] ?? 0));
                        const ok = have >= qty;
                        return (
                          <span key={ing} className={ok ? s.pillGood : s.pillWarn}>
                            {INGREDIENT_LABELS[ing].label} {have}/{qty}
                          </span>
                        );
                      })}
                    </div>
                    <div className={s.rowBetween}>
                      <span className={s.pillAccent}>
                        <Utensils size={10} aria-hidden="true" /> +{recipe.needsDelta.hunger} Hunger · {recipe.moodlet.label}
                      </span>
                      <button
                        type="button"
                        className={s.actionBtn}
                        onClick={() => onSetWaypoint?.('kitchen', `Cook ${recipe.name} at Home Stove`)}
                      >
                        Cook at Home
                      </button>
                    </div>
                  </div>
                ))}

              {marketTab === 'bistro' &&
                BISTRO_MENU.map(item => (
                  <div key={item.id} className={s.card} data-testid={`phone-bistro-${item.id}`}>
                    <div className={s.rowBetween}>
                      <strong>{item.name}</strong>
                      <span className={s.pillGold}>{item.price} CC</span>
                    </div>
                    <p className={s.mutedText}>{item.description}</p>
                    <div className={s.rowBetween}>
                      <span className={s.pillAccent}>
                        <Coffee size={10} aria-hidden="true" /> {item.buff.label}
                      </span>
                      <button
                        type="button"
                        className={s.actionBtn}
                        onClick={() => onSetWaypoint?.('bistro', 'Willow Corner Bistro')}
                      >
                        Visit Bistro
                      </button>
                    </div>
                  </div>
                ))}
            </>
          )}

          {/* ── APP 5: SCHEDULE (SHIFTS, HANGOUTS, SEASONAL FESTIVALS) ─────────────────────────────────── */}
          {app === 'schedule' && (
            <>
              <div className={s.card}>
                <strong>Today (Day {day + 1} · {SEASON_LABELS[seasonIndex]})</strong>
                {scheduleEntries.length === 0 ? (
                  <p className={s.mutedText}>
                    No scheduled workdays or hangouts yet today. Message a neighbor to plan a meetup or enroll in a full-time career.
                  </p>
                ) : (
                  scheduleEntries.map(entry => (
                    <div key={entry.id} className={s.ledgerRow}>
                      <div>
                        <strong>{entry.title}</strong>
                        <p className={s.mutedText}>{entry.timeLabel} · {entry.note}</p>
                      </div>
                      <button
                        type="button"
                        className={s.actionBtn}
                        onClick={() => onSetWaypoint?.(entry.zone, entry.title)}
                      >
                        <MapPin size={12} aria-hidden="true" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className={s.card}>
                <strong>Seasonal Festivals Calendar</strong>
                {SEASONAL_FESTIVALS.map(fest => {
                  const isCurrentSeason = fest.seasonIndex === seasonIndex;
                  return (
                    <div key={fest.title} className={s.ledgerRow}>
                      <div>
                        <div className={s.rowWrap}>
                          <strong>{fest.title}</strong>
                          {isCurrentSeason && <span className={s.pillGood}>This Season</span>}
                        </div>
                        <p className={s.mutedText}>
                          {SEASON_LABELS[fest.seasonIndex]} Day {fest.dayInSeason + 1} · {fest.startHour}:00 to {fest.endHour}:00
                        </p>
                        <p className={s.mutedText}>{fest.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── APP 6: TRANSIT (RIVERSIDE SHUTTLE BUS + OWNED VEHICLES) ────────────────────────────────── */}
          {app === 'transit' && (
            <>
              <div className={s.card}>
                <div className={s.rowBetween}>
                  <strong>Riverside Shuttle Bus</strong>
                  <span className={phoneState.hasStudentPass ? s.pillGood : s.pillGold}>
                    {phoneState.hasStudentPass ? 'Student Pass Free' : `${SHUTTLE_STANDARD_FARE} CC / ride`}
                  </span>
                </div>
                <label className={s.rowBetween}>
                  <span className={s.mutedText}>Departure Stop</span>
                  <select
                    className={s.actionBtn}
                    value={originStopId}
                    aria-label="Departure shuttle stop"
                    onChange={e => setOriginStopId(e.target.value as BusStopId)}
                  >
                    {stops.map(st => (
                      <option key={st.id} value={st.id}>
                        {st.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {stops.map(stop => {
                const isHere = stop.id === originStopId;
                const preview = planBusTrip(originStopId, stop.id, credits, phoneState.hasStudentPass);
                const canBoard = !isHere && preview.ok && (nearestBusStopId === null || nearestBusStopId === originStopId);
                return (
                  <div key={stop.id} className={s.card} data-testid={`phone-stop-${stop.id}`}>
                    <div className={s.rowBetween}>
                      <strong>{stop.name}</strong>
                      <span className={s.pill}>{cleanDisplayCopy(stop.district)}</span>
                    </div>
                    <p className={s.mutedText}>{stop.description}</p>
                    <div className={s.rowBetween}>
                      <span className={s.pillAccent}>
                        {isHere ? 'Current Stop' : `${preview.transitMinutes} min · ${preview.fare === 0 ? 'Free' : `${preview.fare} CC`}`}
                      </span>
                      <div className={s.rowWrap}>
                        <button
                          type="button"
                          className={s.actionBtn}
                          onClick={() => onSetWaypoint?.(stop.zone, stop.name, stop.arrival)}
                        >
                          <MapPin size={12} aria-hidden="true" /> Waypoint
                        </button>
                        {!isHere && (
                          <button
                            type="button"
                            className={s.primaryBtn}
                            disabled={!canBoard}
                            data-testid={`phone-board-${stop.id}`}
                            onClick={() => handleBoardStop(stop.id)}
                          >
                            Board Shuttle
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div className={s.card}>
                <strong>Owned Vehicles</strong>
                {ownedVehicles.length === 0 ? (
                  <p className={s.mutedText}>Visit Greenway Motors along Market Boulevard to purchase bikes, scooters, or electric cars.</p>
                ) : (
                  ownedVehicles.map(v => (
                    <div key={v.instanceId} className={s.ledgerRow}>
                      <div>
                        <strong>{v.name}</strong>
                        <p className={s.mutedText}>
                          {v.kind} {v.locationLabel ? `· ${v.locationLabel}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        className={v.active ? s.pillGood : s.actionBtn}
                        onClick={() => onSummonVehicle?.(v.instanceId)}
                      >
                        <Car size={12} aria-hidden="true" /> {v.active ? 'Active' : 'Select'}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* ── APP 7: KARMA AND 8 EXPANDED SUB-SKILLS ─────────────────────────────────────────────────── */}
          {app === 'karma' && (
            <>
              <div className={s.card} data-testid="phone-karma-card">
                <div className={s.rowBetween}>
                  <strong>Personal Karma</strong>
                  <span className={s.pillAccent}>
                    {mindState.karma.personal > 0 ? `+${mindState.karma.personal}` : mindState.karma.personal} · {mindState.karma.tier}
                  </span>
                </div>
                <div className={s.progressTrack} aria-label={`Personal Karma ${mindState.karma.personal}`}>
                  <span className={s.karmaCenterTick} aria-hidden="true" />
                  <span
                    className={s.karmaMarker}
                    style={{ left: `${Math.max(2, Math.min(98, (mindState.karma.personal + 100) / 2))}%` }}
                  />
                </div>
                <div className={s.rowWrap}>
                  {KARMA_TIERS.map(tier => (
                    <span
                      key={tier}
                      className={mindState.karma.tier === tier ? s.pillGood : s.pill}
                    >
                      {tier}
                    </span>
                  ))}
                </div>
              </div>

              <div className={s.card}>
                <div className={s.rowBetween}>
                  <strong>City Karma</strong>
                  <span className={s.pillGood}>
                    {mindState.karma.city}/100 · {mindState.karma.cityBand}
                  </span>
                </div>
                <div className={s.progressTrack}>
                  <div className={s.progressFill} style={{ width: `${mindState.karma.city}%` }} />
                </div>
              </div>

              <div className={s.card} data-testid="phone-subskills-card">
                <strong>Lifestyle Sub-Skills (8)</strong>
                {SUB_SKILL_IDS.map(skillId => {
                  const def = SUB_SKILL_CATALOG[skillId];
                  const prog = mindState.subSkills[skillId];
                  const floorXp = SUB_SKILL_THRESHOLDS[Math.max(0, prog.level - 1)] ?? 0;
                  const pct = prog.nextLevelXp
                    ? Math.min(100, Math.round(((prog.xp - floorXp) / Math.max(1, prog.nextLevelXp - floorXp)) * 100))
                    : 100;
                  return (
                    <div key={skillId} style={{ display: 'grid', gap: 3 }}>
                      <div className={s.rowBetween}>
                        <strong>{def.label}</strong>
                        <span className={s.pillAccent}>
                          Lv. {prog.level} {prog.nextLevelXp ? `(${prog.xp}/${prog.nextLevelXp} XP)` : 'MAX'}
                        </span>
                      </div>
                      <div className={s.progressTrack}>
                        <div className={s.progressFill} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ── APP 8: ECHO BANK ───────────────────────────────────────────────────────────────────────── */}
          {app === 'bank' && (
            <>
              <div className={s.bankGrid} data-testid="phone-bank-summary">
                <div className={s.bankMetric}>
                  <span>Campus Credits</span>
                  <strong style={{ color: 'var(--ph-gold)' }}>{bankSummary.currentBalance} CC</strong>
                </div>
                <div className={s.bankMetric}>
                  <span>Estimated Net Worth</span>
                  <strong>{bankSummary.estimatedNetWorth} CC</strong>
                </div>
                <div className={s.bankMetric}>
                  <span>Recent Earned</span>
                  <strong style={{ color: 'var(--ph-emerald)' }}>+{bankSummary.totalIncomeRecent} CC</strong>
                </div>
                <div className={s.bankMetric}>
                  <span>Recent Spent</span>
                  <strong style={{ color: 'var(--ph-rose)' }}>-{bankSummary.totalExpenseRecent} CC</strong>
                </div>
              </div>

              <div className={s.card}>
                <div className={s.rowBetween}>
                  <strong>Recent Ledger</strong>
                  <span className={s.pill}>{phoneState.ledger.length} entries</span>
                </div>
                {[...phoneState.ledger].reverse().map(entry => (
                  <div key={entry.id} className={s.ledgerRow}>
                    <div>
                      <strong>{entry.source}</strong>
                      <p className={s.mutedText}>Day {entry.day + 1} · {entry.time}</p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className={entry.delta >= 0 ? s.pillGood : s.pillWarn}>
                        {entry.delta >= 0 ? `+${entry.delta}` : entry.delta} CC
                      </span>
                      <p className={s.mutedText}>{entry.balanceAfter} CC</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── APP 9: GALLERY ─────────────────────────────────────────────────────────────────────────── */}
          {app === 'gallery' && (
            <>
              {phoneState.photos.length === 0 ? (
                <div className={s.card}>
                  <strong>No Photos Saved Yet</strong>
                  <p className={s.mutedText}>
                    Open Photo Studio (press P) anywhere in Riverside to freeze time, pick a film filter, and save shots directly here.
                  </p>
                </div>
              ) : (
                <div className={s.galleryGrid} data-testid="phone-gallery-grid">
                  {phoneState.photos.map(photo => {
                    const dataUrl = loadPhotoThumb(accountKey, photo.thumbKey);
                    return (
                      <button
                        key={photo.id}
                        type="button"
                        className={s.photoThumbBtn}
                        data-testid={`phone-photo-${photo.id}`}
                        onClick={() => setSelectedPhoto(photo)}
                      >
                        <div className={s.photoImgWrap}>
                          {dataUrl ? (
                            <img src={dataUrl} alt={photo.title} />
                          ) : (
                            <ImageIcon size={24} aria-hidden="true" />
                          )}
                        </div>
                        <div className={s.photoCaption}>
                          <strong>{photo.title}</strong>
                          <small>{photo.zone} · {photo.filter}</small>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Workplace Dilemma Modal Overlay inside Phone */}
        {activeDilemma && (
          <div className={s.sheetOverlay} role="dialog" aria-label="Workplace Dilemma" data-testid="phone-dilemma-modal">
            <div className={s.sheetCard}>
              <div className={s.rowBetween}>
                <strong>{activeDilemma.title}</strong>
                <button
                  type="button"
                  className={s.closePhoneBtn}
                  aria-label="Close workplace dilemma"
                  onClick={() => {
                    setActiveDilemma(null);
                    setDilemmaResult(null);
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <p className={s.mutedText}>{activeDilemma.prompt}</p>

              {!dilemmaResult ? (
                <div style={{ display: 'grid', gap: 7 }}>
                  {activeDilemma.choices.map(ch => (
                    <button
                      key={ch.id}
                      type="button"
                      className={s.dilemmaChoiceBtn}
                      data-testid={`phone-dilemma-choice-${ch.id}`}
                      onClick={() => handleChooseDilemma(ch.id)}
                    >
                      <strong>{ch.label}</strong>
                      <div className={s.rowWrap}>
                        <span className={ch.karmaDelta >= 0 ? s.pillGood : s.pillWarn}>
                          Karma {ch.karmaDelta >= 0 ? `+${ch.karmaDelta}` : ch.karmaDelta}
                        </span>
                        <span className={s.pillAccent}>
                          Recognition {ch.recognitionDelta >= 0 ? `+${ch.recognitionDelta}` : ch.recognitionDelta}
                        </span>
                        <span className={s.pillGold}>Promotion +{ch.promotionDelta}%</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className={s.card}>
                  <strong>{dilemmaResult.promoted ? `Promoted to ${dilemmaResult.newRankTitle}!` : 'Decision Resolved'}</strong>
                  <p className={s.mutedText}>{dilemmaResult.choice?.outcomeText}</p>
                  <button
                    type="button"
                    className={s.primaryBtn}
                    onClick={() => {
                      setActiveDilemma(null);
                      setDilemmaResult(null);
                    }}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Photo Lightbox Overlay inside Phone */}
        {selectedPhoto && (
          <div className={s.sheetOverlay} role="dialog" aria-label={selectedPhoto.title} data-testid="phone-photo-lightbox">
            <div className={s.sheetCard}>
              <div className={s.rowBetween}>
                <strong>{selectedPhoto.title}</strong>
                <button
                  type="button"
                  className={s.closePhoneBtn}
                  aria-label="Close photo preview"
                  onClick={() => setSelectedPhoto(null)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
              <div className={s.photoImgWrap}>
                {selectedPhotoDataUrl ? (
                  <img src={selectedPhotoDataUrl} alt={selectedPhoto.title} />
                ) : (
                  <ImageIcon size={32} aria-hidden="true" />
                )}
              </div>
              <div className={s.rowWrap}>
                <span className={s.pillAccent}>{selectedPhoto.zone}</span>
                <span className={s.pillGood}>{selectedPhoto.season}</span>
                <span className={s.pillGold}>{selectedPhoto.filter}</span>
              </div>
              <div className={s.rowBetween}>
                {selectedPhotoDataUrl ? (
                  <a
                    href={selectedPhotoDataUrl}
                    download={`echo-life-${selectedPhoto.id}.png`}
                    className={s.primaryBtn}
                    style={{ textDecoration: 'none' }}
                  >
                    <Download size={13} aria-hidden="true" /> Download PNG
                  </a>
                ) : (
                  <span className={s.mutedText}>Thumbnail stored locally</span>
                )}
                <button
                  type="button"
                  className={s.actionBtn}
                  data-testid="phone-photo-delete"
                  onClick={() => handleDeletePhoto(selectedPhoto)}
                >
                  <Trash2 size={13} aria-hidden="true" /> Delete
                </button>
              </div>
            </div>
          </div>
        )}

        <span className={s.homeIndicator} aria-hidden="true" />
      </div>
    </aside>
  );
}
