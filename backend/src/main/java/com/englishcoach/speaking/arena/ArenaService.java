package com.englishcoach.speaking.arena;

import static com.englishcoach.speaking.arena.ArenaProtocol.*;
import org.springframework.stereotype.Service;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

/** Bounded, ephemeral live rooms. No frame history, audio, transcript, AI or proficiency points. */
@Service
public class ArenaService implements AutoCloseable, com.englishcoach.messenger.ArenaInvites {
    static final int MAX_ROOMS = 48, PROMPTS = 12, MAX_VOICE_TICKETS_PER_WINDOW = 20;
    static final long LEASE_MS = 35_000, ROOM_MS = 90 * 60_000, BOAT_RETURN_MS = 45_000;
    static final long VOICE_COOLDOWN_MS = 5_000, VOICE_WINDOW_MS = 10 * 60_000L;
    private static final int MAX_DISCONNECTED_SESSIONS = 2048;
    static final String GROUND_SEAT = "__ground__";
    private static final double BOAT_SEAT_Y = ArenaGeometry.WATER_Y + 0.394;
    private final ArenaVoice voice;
    private final ArenaEvents events;
    private final ArenaUsage usage;
    private boolean recovered;
    private volatile boolean stopped;
    private final Clock clock;
    private final ConcurrentMap<UUID, Room> rooms = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, UUID> active = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, Attempt> attempts = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, Long> lastVoiceTicketAt = new ConcurrentHashMap<>();
    private final ConcurrentMap<Long, Deque<Long>> voiceTicketHistory = new ConcurrentHashMap<>();
    private final LinkedHashSet<String> disconnectedSessions = new LinkedHashSet<>();
    private final Object admission = new Object();
    private static final long RESERVED_MS = 10 * 60_000;
    private final SecureRandom random = new SecureRandom();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        var t = new Thread(r, "speaking-arena-tick");
        t.setDaemon(true);
        return t;
    });
    private final ThreadPoolExecutor controls = createControlsPool();
    private final ThreadPoolExecutor voiceIo = createVoiceIoPool();

    private static ThreadPoolExecutor createControlsPool() {
        var pool = new ThreadPoolExecutor(6, 6, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(96), r -> {
            var t = new Thread(r, "speaking-arena-control");
            t.setDaemon(true);
            return t;
        }, new ThreadPoolExecutor.AbortPolicy());
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }

    private static ThreadPoolExecutor createVoiceIoPool() {
        var pool = new ThreadPoolExecutor(8, 8, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(64), r -> {
            var t = new Thread(r, "speaking-arena-voice-io");
            t.setDaemon(true);
            return t;
        }, new ThreadPoolExecutor.CallerRunsPolicy());
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }

    private record Attempt(long start, int count) {}

    static class Boat {
        final String id;
        final String model;
        final boolean motor;
        final boolean canEngine;
        final double[][] hull;
        boolean engine;
        double speed, throttle, steering, yawRate;
        final double homeX, homeZ, homeYaw;
        double x, z, yaw, rowPhase, travelCredit = 2.2;
        UUID rower, passenger;
        long sequence = -1, lastMove, emptySince;
        boolean moved;

        Boat(ArenaGeometry.BoatSpec spec) {
            this.id = spec.id();
            this.model = spec.model();
            this.motor = "pelagic".equals(model) || "tern".equals(model) || "cruiser".equals(model);
            this.canEngine = this.motor || "sampan".equals(model);
            this.hull = ArenaGeometry.hullForModel(model);
            this.homeX = this.x = spec.x();
            this.homeZ = this.z = spec.z();
            this.homeYaw = this.yaw = spec.yaw();
        }

        BoatState toState() {
            return new BoatState(id, x, z, yaw, rowPhase, rower, passenger, sequence, lastMove, engine, throttle, steering, speed);
        }
    }

    static class Member {
        final long user;
        final UUID id = UUID.randomUUID();
        final String principal, name, hero;
        String session, pendingSession, voiceId = UUID.randomUUID().toString(), gesture = "IDLE", wear = "";
        int team;
        boolean ready, online = true, moderated, revokePending, pendingSessionDisconnected;
        long seen, lastMove, sequence = -1, voiceIssued, gestureUntil;
        double x, z, yaw, jumpFloor, supportY, jumpSpeed = 5, travelCredit = 1.4, diveDepth;
        String seat, boat, boatRole, artifact;
        int artifactTurn;
        boolean jumpHeld;
        long jumpAt;
        boolean moved, motionClient;
        final LinkedHashMap<UUID, Boolean> receipts = new LinkedHashMap<>();
        long controlWindow;
        int controlCount;

        Member(long user, String principal, String session, String name, String hero, long now, int index) {
            this.user = user;
            this.principal = principal;
            this.session = session;
            this.name = name;
            this.hero = hero;
            this.seen = now;
            this.team = index % 2;
            this.x = (team == 0 ? -1 : 1) * (2 + index / 2.0);
            this.z = 2;
            this.yaw = team == 0 ? Math.PI / 2 : -Math.PI / 2;
            this.supportY = ArenaGeometry.supportY(this.x, this.z);
        }
    }

    static class Room {
        final UUID id = UUID.randomUUID();
        final String code, media;
        final Mode mode;
        final boolean publicMatch;
        final long created;
        final LinkedHashMap<Long, Member> members = new LinkedHashMap<>();
        final LinkedHashMap<String, Boat> boats = new LinkedHashMap<>();
        final LinkedHashSet<String> beacons = new LinkedHashSet<>();
        /** Where each table object rests (moved only by put-item, onto a table, slot chosen here). */
        final LinkedHashMap<String, ItemState> items = new LinkedHashMap<>();
        final Set<Long> banned = new HashSet<>();
        final ReentrantLock control = new ReentrantLock();
        final List<Award> awards = new ArrayList<>();
        UUID host, speaker;
        Phase phase = Phase.LOBBY;
        long revision = 1, deadline, retryAfter;
        int round, prompt, coral, lagoon;
        boolean dirty = true, pending, closing;
        final UUID createRequest;
        /** A room kept for the people of an accepted invitation: nobody else enters by its code, and its provider room opens when the first of them arrives. */
        Set<Long> reservedFor;
        long reservedUntil;
        boolean opened;
        int socialCapacity = 8;
        String title = "", topic = "";

        Room(String code, Mode mode, boolean quick, long now, UUID request) {
            this.code = code;
            this.mode = mode;
            this.publicMatch = quick;
            this.created = now;
            this.createRequest = request;
            this.media = "ec-speaking-" + id;
            for (var spec : ArenaGeometry.LAYOUT.boats()) {
                this.boats.put(spec.id(), new Boat(spec));
            }
            for (var inter : ArenaGeometry.LAYOUT.interactables()) {
                if ("beacon".equals(inter.kind())) this.beacons.add(inter.id());
                if ("artifact".equals(inter.kind())) {
                    var table = ArenaGeometry.LAYOUT.furniture().stream()
                            .filter(f -> "table".equals(f.kind()) && Math.hypot(f.x() - inter.x(), f.z() - inter.z()) < .5).findFirst().orElse(null);
                    this.items.put(inter.id(), new ItemState(inter.id(), table == null ? null : table.id(), inter.x(), inter.z(),
                            ArenaGeometry.floor(inter.x(), inter.z()), inter.yaw()));
                }
            }
        }

        int capacity() {
            return mode == Mode.DUEL ? 2 : mode == Mode.TEAM ? 4 : socialCapacity;
        }
    }

    @org.springframework.beans.factory.annotation.Autowired
    public ArenaService(ArenaVoice voice, ArenaEvents events, ArenaUsage usage) {
        this(voice, events, usage, Clock.systemUTC());
        timer.scheduleWithFixedDelay(this::safeTick, 100, 100, TimeUnit.MILLISECONDS);
    }

    ArenaService(ArenaVoice voice, ArenaEvents events, ArenaUsage usage, Clock clock) {
        this.voice = voice;
        this.events = events;
        this.usage = usage;
        this.clock = clock;
    }

    private void safeTick() {
        try {
            tick();
        } catch (RuntimeException ignored) {
            /* A broker failure must not cancel future maintenance. */
        }
    }

    synchronized void recover() {
        if (recovered) return;
        usage.recover(now());
        for (String room : usage.orphanRooms()) {
            voice.close(room);
            usage.closeRoom(room, now());
        }
        recovered = true;
    }

    public Map<String, Object> usage() {
        return usage.status(now());
    }

    private long now() {
        return clock.millis();
    }

    static ResponseStatusException fail(int status, String code) {
        return new ResponseStatusException(HttpStatus.valueOf(status), code);
    }

    private static void require(boolean ok, String code) {
        if (!ok) throw fail(409, code);
    }

    private static double normAngle(double a) {
        return Math.atan2(Math.sin(a), Math.cos(a));
    }

    public boolean available() {
        return !stopped && voice.available() && usage.configured();
    }

    public void submit(Runnable job) {
        if (stopped) throw fail(503, "ARENA_BUSY");
        try {
            controls.execute(job);
        } catch (RejectedExecutionException e) {
            throw fail(429, "ARENA_BUSY");
        }
    }

    private void entranceLimit(long user) {
        long now = now();
        Attempt a = attempts.compute(user, (k, old) -> old == null || now - old.start > 60_000 ? new Attempt(now, 1) : new Attempt(old.start, old.count + 1));
        if (a.count > 10) throw fail(429, "JOIN_RATE_LIMIT");
        if (attempts.size() > 4096) attempts.entrySet().removeIf(e -> now - e.getValue().start > 60_000);
        if (attempts.size() > 8192) throw fail(503, "ARENA_BUSY");
    }

    private void checkVoiceRateLimit(long uid, Member m, long now) {
        Long last = lastVoiceTicketAt.get(uid);
        long anchor = Math.max(m.voiceIssued, last == null ? 0L : last);
        if (anchor != 0L && now - anchor < VOICE_COOLDOWN_MS) {
            throw fail(429, "VOICE_RATE_LIMIT");
        }
        Deque<Long> history = voiceTicketHistory.get(uid);
        if (history != null) {
            synchronized (history) {
                pruneVoiceWindow(history, now);
                if (history.size() >= MAX_VOICE_TICKETS_PER_WINDOW) {
                    throw fail(429, "VOICE_RATE_LIMIT");
                }
            }
        }
    }

    private void recordVoiceTicket(long uid, long now) {
        lastVoiceTicketAt.put(uid, now);
        Deque<Long> history = voiceTicketHistory.computeIfAbsent(uid, k -> new ArrayDeque<>());
        synchronized (history) {
            pruneVoiceWindow(history, now);
            history.addLast(now);
        }
        if (lastVoiceTicketAt.size() > 4096) {
            lastVoiceTicketAt.entrySet().removeIf(e -> now - e.getValue() > VOICE_WINDOW_MS);
        }
        if (voiceTicketHistory.size() > 4096) {
            voiceTicketHistory.entrySet().removeIf(e -> {
                synchronized (e.getValue()) {
                    pruneVoiceWindow(e.getValue(), now);
                    return e.getValue().isEmpty();
                }
            });
        }
    }

    private static void pruneVoiceWindow(Deque<Long> history, long now) {
        while (!history.isEmpty() && now - history.peekFirst() >= VOICE_WINDOW_MS) {
            history.pollFirst();
        }
    }

    private void markSessionDisconnected(String session) {
        if (session == null || session.isEmpty()) return;
        synchronized (disconnectedSessions) {
            disconnectedSessions.remove(session);
            disconnectedSessions.add(session);
            while (disconnectedSessions.size() > MAX_DISCONNECTED_SESSIONS) {
                Iterator<String> it = disconnectedSessions.iterator();
                it.next();
                it.remove();
            }
        }
    }

    private boolean wasSessionDisconnected(String session) {
        if (session == null || session.isEmpty()) return false;
        synchronized (disconnectedSessions) {
            return disconnectedSessions.contains(session);
        }
    }

    private void markMemberOfflineLocked(Room r, Member m, long now) {
        m.online = false;
        if ("OBSERVE".equals(m.gesture)) m.gestureUntil = 0;
        m.artifact = null;
        m.diveDepth = 0;
        m.revokePending = true;
        if (m.seat != null) {
            standOffSeat(m, m.seat);
            m.moved = true;
        }
        if (m.boat != null) {
            Boat held = r.boats.get(m.boat);
            ArenaGeometry.Landing land = held == null ? null : ArenaGeometry.disembarkPoint(held.x, held.z, held.yaw, held.hull);
            releaseFromBoat(r, m, now);
            if (land != null) {
                m.x = land.x();
                m.z = land.z();
                m.supportY = land.y();
            } else {
                m.x = (m.team == 0 ? -2 : 2);
                m.z = 2;
                m.supportY = ArenaGeometry.supportY(m.x, m.z);
            }
        }
    }

    private String code() {
        String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 8; i++) b.append(alphabet.charAt(random.nextInt(alphabet.length())));
        return b.toString();
    }

    private String nickname(String value) {
        String s = value == null ? "" : value.trim().replaceAll("\\s+", " ");
        if (s.length() < 2 || s.length() > 24 || !s.matches("[\\p{L}\\p{M}\\p{N} _.'-]+"))
            throw fail(400, "NICKNAME_INVALID");
        return s;
    }

    private static String hero(String value) {
        if (!Set.of("LYRA", "KAI").contains(value == null ? "" : value)) throw fail(400, "HERO_INVALID");
        return value;
    }

    private static boolean allowed(Room r, Member m, Phase phase, UUID speaker) {
        return !m.moderated && (phase == Phase.FREE || phase == Phase.TALK && m.id.equals(speaker));
    }

    private static void changed(Room r) {
        r.revision++;
        r.dirty = true;
    }

    private Room owned(long uid, UUID id) {
        Room r = id == null ? null : rooms.get(id);
        if (r == null || !id.equals(active.get(uid))) throw fail(404, "ROOM_NOT_FOUND");
        return r;
    }

    private Member member(Room r, long uid) {
        Member m = r.members.get(uid);
        if (m == null) throw fail(404, "ROOM_NOT_FOUND");
        return m;
    }

    private static void bound(Member m, String session) {
        if (!Objects.equals(m.session, session)) throw fail(409, "SESSION_REPLACED");
    }

    public State get(long uid, UUID id) {
        Room r = owned(uid, id);
        synchronized (r) {
            return snapshot(r, member(r, uid));
        }
    }

    private State snapshot(Room r, Member viewer) {
        long now = now();
        return new State(
                r.id, r.code, r.mode, r.phase, r.host, viewer.id, r.speaker, r.revision, now, r.deadline,
                r.round, r.prompt, r.coral, r.lagoon,
                r.members.values().stream().map(m -> new Player(
                        m.id, m.user, m.name, m.hero, m.team, m.ready, m.online, m.moderated,
                        allowed(r, m, r.phase, r.speaker), m.voiceId, m.x, m.z, m.yaw,
                        m.gestureUntil > now ? m.gesture : "IDLE", m.wear,
                        m.gestureUntil == 0 ? 0 : m.gestureUntil - 2600,
                        m.sequence, m.lastMove, m.jumpAt, m.jumpFloor, m.supportY, m.jumpSpeed,
                        m.seat, m.boat, m.boatRole, m.artifact, m.artifactTurn, m.diveDepth
                )).toList(),
                List.copyOf(r.awards), r.publicMatch, r.capacity(), r.title, r.topic, r.reservedFor != null,
                r.boats.values().stream().map(Boat::toState).toList(),
                List.copyOf(r.beacons),
                List.copyOf(r.items.values())
        );
    }

    public State act(long uid, String principal, String session, String action, Command c) {
        if (stopped) throw fail(503, "ARENA_BUSY");
        if (c == null) throw fail(400, "COMMAND_INVALID");
        if (action.equals("sync")) {
            UUID id = active.get(uid);
            return id == null ? null : get(uid, id);
        }
        if (Set.of("create", "join", "quick").contains(action)) return enter(uid, principal, session, action, c);
        Room r = owned(uid, c.roomId());
        if (action.equals("move") || action.equals("row") || action.equals("ping")) {
            synchronized (r) {
                Member m = member(r, uid);
                bound(m, session);
                m.seen = now();
                m.online = true;
                if (action.equals("move")) move(r, m, c);
                else if (action.equals("row")) row(r, m, c);
                return null;
            }
        }
        if (!r.control.tryLock()) throw fail(409, "ROOM_BUSY");
        try {
            Member m;
            synchronized (r) {
                m = member(r, uid);
                if (!action.equals("rejoin")) bound(m, session);
                require(c.requestId() != null, "REQUEST_ID_REQUIRED");
                if (m.receipts.containsKey(c.requestId())) return snapshot(r, m);
                if (now() - m.controlWindow >= 10_000) {
                    m.controlWindow = now();
                    m.controlCount = 0;
                }
                if (++m.controlCount > 16) throw fail(429, "ACTION_RATE_LIMIT");
                require(!r.closing, "ROOM_CLOSED");
                m.seen = now();
            }
            switch (action) {
                case "rejoin" -> {
                    synchronized (r) {
                        if (wasSessionDisconnected(session)) {
                            throw fail(409, "CONNECTION_REQUIRED");
                        }
                        m.pendingSession = session;
                        m.pendingSessionDisconnected = false;
                    }
                    try {
                        rotate(r, m, false);
                    } catch (RuntimeException e) {
                        synchronized (r) {
                            if (Objects.equals(m.pendingSession, session)) {
                                m.pendingSession = null;
                                m.pendingSessionDisconnected = false;
                            }
                        }
                        throw e;
                    }
                    synchronized (r) {
                        boolean dead = m.pendingSessionDisconnected || wasSessionDisconnected(session);
                        if (Objects.equals(m.pendingSession, session)) {
                            m.pendingSession = null;
                            m.pendingSessionDisconnected = false;
                        }
                        String old = m.session;
                        m.session = session;
                        m.sequence = -1;
                        m.moved = false;
                        m.motionClient = false;
                        m.jumpAt = 0;
                        m.lastMove = now();
                        if (m.boat != null) {
                            Boat b = r.boats.get(m.boat);
                            if (b != null && Objects.equals(b.rower, m.id)) b.sequence = -1;
                        }
                        if (!Objects.equals(old, session))
                            events.send(m.principal, old, new Event("REPLACED", null, null, null));
                        if (dead) {
                            markMemberOfflineLocked(r, m, now());
                            m.revokePending = false;
                            changed(r);
                            throw fail(409, "CONNECTION_REQUIRED");
                        }
                        m.online = true;
                        m.revokePending = false;
                        changed(r);
                    }
                }
                case "leave" -> {
                    remove(r, m, "LEFT");
                    return null;
                }
                case "sit", "stand" -> {
                    synchronized (r) {
                        setSeated(r, m, action.equals("sit"), c.item());
                    }
                }
                case "take-item", "turn-item", "put-item" -> {
                    synchronized (r) {
                        if ("take-item".equals(action)) {
                            var item = ArenaGeometry.LAYOUT.interactables().stream()
                                .filter(i -> "artifact".equals(i.kind()) && i.id().equals(c.item())).findFirst()
                                .orElseThrow(() -> fail(409, "OUT_OF_RANGE"));
                            ItemState rest = r.items.get(item.id());
                            require(rest != null && m.artifact == null, "HANDS_FULL");
                            require(m.boat == null && m.seat == null && !ArenaGeometry.isSwimming(m.x, m.z)
                                    && Math.hypot(m.x - rest.x(), m.z - rest.z()) <= item.range() + .15
                                    && ArenaGeometry.inReach(m.x, m.z, rest.x(), rest.z()), "OUT_OF_RANGE");
                            require(feetAt(m, now()) <= m.supportY + .12, "LAND_FIRST");
                            require(r.members.values().stream().noneMatch(v -> v != m && item.id().equals(v.artifact)), "ITEM_IN_USE");
                            m.artifact = item.id();
                            m.artifactTurn = 0;
                        } else if ("turn-item".equals(action)) {
                            require(m.artifact != null && m.artifact.equals(c.item()), "OUT_OF_RANGE");
                            m.artifactTurn = (m.artifactTurn + 1) % 8;
                        } else if (m.artifact != null) {
                            placeItem(r, m, c.place());
                            m.artifact = null;
                        }
                        changed(r);
                    }
                }
                case "engine" -> {
                    synchronized (r) {
                        Boat boat = r.boats.get(m.boat);
                        require(boat != null && boat.canEngine && m.id.equals(boat.rower), "NOT_ROWING");
                        boat.engine = Boolean.TRUE.equals(c.value());
                        boat.throttle = 0;
                        boat.lastMove = now();
                        boat.moved = true;
                        changed(r);
                    }
                }
                case "observe" -> {
                    synchronized (r) {
                        if (c.item() != null) {
                            var instrument = ArenaGeometry.LAYOUT.interactables().stream()
                                .filter(i -> i.id().equals(c.item()) && i.kind().equals("telescope")).findFirst()
                                .orElseThrow(() -> fail(409, "OUT_OF_RANGE"));
                            require(m.boat == null && m.seat == null && m.artifact == null && !ArenaGeometry.isSwimming(m.x, m.z)
                                    && Math.hypot(m.x - instrument.x(), m.z - instrument.z()) <= instrument.range() + .15
                                    && ArenaGeometry.inReach(m.x, m.z, instrument.x(), instrument.z()), "OUT_OF_RANGE");
                            m.gesture = "OBSERVE";
                            m.gestureUntil = Long.MAX_VALUE;
                        } else if ("OBSERVE".equals(m.gesture)) m.gestureUntil = 0;
                        changed(r);
                    }
                }
                case "board" -> {
                    synchronized (r) {
                        boardBoat(r, m, c.item());
                    }
                }
                case "disembark" -> {
                    synchronized (r) {
                        disembarkBoat(r, m);
                    }
                }
                case "jump-overboard" -> {
                    synchronized (r) {
                        jumpOverboard(r, m, c.aux());
                    }
                }
                case "climb-dock" -> {
                    synchronized (r) {
                        require(m.boat == null && m.seat == null, "ALREADY_SEATED");
                        ArenaGeometry.Landing climb = ArenaGeometry.climbOutPoint(m.x, m.z);
                        require(climb != null, "NO_LANDING_NEARBY");
                        m.x = climb.x();
                        m.z = climb.z();
                        m.supportY = climb.y();
                        m.diveDepth = 0;
                        m.jumpAt = 0;
                        m.jumpHeld = false;
                        m.travelCredit = 1.4;
                        m.lastMove = now();
                        m.moved = true;
                        changed(r);
                    }
                }
                case "boat-free" -> {
                    synchronized (r) {
                        freeBoat(r, m);
                    }
                }
                case "beacon" -> {
                    synchronized (r) {
                        toggleBeacon(r, m, c.item());
                    }
                }
                case "ready" -> {
                    synchronized (r) {
                        require(r.phase == Phase.LOBBY, "MATCH_STARTED");
                        m.ready = Boolean.TRUE.equals(c.value());
                        changed(r);
                    }
                }
                case "wave", "listen", "cheer", "clap", "dance", "cast", "reel", "catch", "shake" -> {
                    synchronized (r) {
                        boolean fishingTransition = Set.of("reel", "catch").contains(action)
                                && Set.of("CAST", "REEL").contains(m.gesture);
                        if (!fishingTransition && now() < m.gestureUntil) throw fail(429, "ACTION_RATE_LIMIT");
                        m.gesture = action.toUpperCase(Locale.ROOT);
                        m.gestureUntil = now() + ("reel".equals(action) ? 6000 : 2600);
                        changed(r);
                    }
                }
                default -> {
                    synchronized (r) {
                        if (!m.id.equals(r.host)) throw fail(403, "HOST_ONLY");
                    }
                    hostAction(r, c, action);
                }
            }
            synchronized (r) {
                m.receipts.put(c.requestId(), true);
                while (m.receipts.size() > 96) m.receipts.remove(m.receipts.keySet().iterator().next());
                return snapshot(r, m);
            }
        } finally {
            r.control.unlock();
        }
    }

    private State enter(long uid, String principal, String session, String action, Command c) {
        if (!available()) throw fail(503, "VOICE_UNAVAILABLE");
        require(c.requestId() != null, "REQUEST_ID_REQUIRED");
        entranceLimit(uid);
        recover();
        String name = nickname(c.nickname()), look = hero(c.hero());
        Room r;
        boolean created = false;
        synchronized (admission) {
            UUID existing = active.get(uid);
            if (existing != null) {
                Room old = rooms.get(existing);
                if (old != null && old.createRequest.equals(c.requestId())) {
                    synchronized (old) {
                        Member m = member(old, uid);
                        bound(m, session);
                        return snapshot(old, m);
                    }
                }
                throw fail(409, "ALREADY_IN_ROOM");
            }
            require(active.size() < usage.concurrentLimit(), "ARENA_FULL");
            r = null;
            if (action.equals("join")) {
                String requested = c.code() == null ? "" : c.code().replace("-", "").trim().toUpperCase(Locale.ROOT);
                if (!requested.matches("[A-Z2-9]{8}")) throw fail(404, "ROOM_NOT_FOUND");
                r = rooms.values().stream().filter(x -> x.code.equals(requested)).findFirst().orElseThrow(() -> fail(404, "ROOM_NOT_FOUND"));
            } else {
                require(c.mode() != null, "MODE_REQUIRED");
                if (action.equals("quick")) {
                    require(c.mode() == Mode.DUEL || c.mode() == Mode.TEAM, "MODE_INVALID");
                    for (Room candidate : rooms.values())
                        synchronized (candidate) {
                            if (candidate.publicMatch && candidate.mode == c.mode() && candidate.phase == Phase.LOBBY && !candidate.pending && !candidate.closing && candidate.members.size() < candidate.capacity() && !candidate.banned.contains(uid)) {
                                r = candidate;
                                break;
                            }
                        }
                }
                if (r == null) {
                    require(rooms.size() < MAX_ROOMS, "ARENA_FULL");
                    String code;
                    do {
                        code = code();
                    } while (hasCode(code));
                    r = new Room(code, c.mode(), action.equals("quick"), now(), c.requestId());
                    if (action.equals("create")) {
                        if (c.capacity() != null) {
                            int cap = c.capacity();
                            require(cap >= 2 && cap <= r.capacity() && ((r.mode != Mode.DUEL && r.mode != Mode.TEAM) || cap == r.capacity()), "CAPACITY_INVALID");
                            r.socialCapacity = cap;
                        }
                        r.title = label(c.title(), 48);
                        r.topic = label(c.topic(), 120);
                    }
                    r.pending = true;
                    rooms.put(r.id, r);
                    created = true;
                }
            }
            if (!r.control.tryLock()) throw fail(409, "ROOM_BUSY");
            synchronized (r) {
                if (r.reservedFor != null && !r.reservedFor.contains(uid)) {
                    r.control.unlock();
                    throw fail(404, "ROOM_NOT_FOUND");
                }
                boolean accepting = r.phase == Phase.LOBBY || r.phase == Phase.FREE && (r.mode == Mode.FREE || r.mode == Mode.GUIDED);
                if ((r.pending && !created) || r.closing || r.banned.contains(uid) || !accepting) {
                    r.control.unlock();
                    throw fail(409, "ROOM_UNAVAILABLE");
                }
                if (r.members.size() >= r.capacity()) {
                    r.control.unlock();
                    throw fail(409, "ROOM_FULL");
                }
                active.put(uid, r.id);
            }
        }
        boolean registered = false;
        boolean providerCreated = false;
        try {
            if (created || !r.opened) {
                usage.register(r.media);
                registered = true;
                voice.create(r.media, r.capacity());
                providerCreated = true;
                r.opened = true;
            }
            if (stopped) throw fail(503, "ARENA_BUSY");
            synchronized (r) {
                Member m = new Member(uid, principal, session, name, look, now(), r.members.size());
                m.wear = com.englishcoach.common.AvatarLookCode.clean(c.look());
                r.members.put(uid, m);
                if (r.host == null) r.host = m.id;
                r.pending = false;
                changed(r);
                return snapshot(r, m);
            }
        } catch (RuntimeException e) {
            active.remove(uid, r.id);
            if (providerCreated) {
                boolean closedOnProvider = false;
                try {
                    voice.close(r.media);
                    closedOnProvider = true;
                } catch (RuntimeException ignored) {}
                if (closedOnProvider) {
                    try {
                        usage.closeRoom(r.media, now());
                    } catch (RuntimeException ignored) {}
                    if (created) rooms.remove(r.id, r);
                } else {
                    synchronized (r) {
                        r.closing = true;
                        r.pending = false;
                    }
                }
            } else {
                if (registered) {
                    try {
                        voice.close(r.media);
                    } catch (RuntimeException ignored) {}
                    try {
                        usage.closeRoom(r.media, now());
                    } catch (RuntimeException ignored) {}
                }
                if (created) {
                    rooms.remove(r.id, r);
                }
            }
            throw e;
        } finally {
            r.control.unlock();
        }
    }

    @Override
    public String reserve(String mode, long inviter, long invitee) {
        if (!available()) throw fail(503, "VOICE_UNAVAILABLE");
        Mode kind;
        try {
            kind = Mode.valueOf(mode);
        } catch (RuntimeException e) {
            throw fail(400, "MODE_INVALID");
        }
        synchronized (admission) {
            UUID existing = active.get(inviter);
            Room here = existing == null ? null : rooms.get(existing);
            if (here != null) synchronized (here) {
                boolean accepting = here.phase == Phase.LOBBY || here.phase == Phase.FREE && (here.mode == Mode.FREE || here.mode == Mode.GUIDED);
                if (!here.publicMatch && !here.closing && accepting && here.members.size() < here.capacity() && !here.banned.contains(invitee)) {
                    if (here.reservedFor != null) here.reservedFor.add(invitee);
                    return here.code;
                }
            }
            require(rooms.size() < MAX_ROOMS, "ARENA_FULL");
            String code;
            do {
                code = code();
            } while (hasCode(code));
            Room r = new Room(code, kind, false, now(), UUID.randomUUID());
            r.reservedFor = new HashSet<>(Set.of(inviter, invitee));
            r.reservedUntil = now() + RESERVED_MS;
            rooms.put(r.id, r);
            return code;
        }
    }

    private static String label(String text, int max) {
        if (text == null) return "";
        String clean = text.strip();
        require(clean.length() <= max && clean.codePoints().noneMatch(Character::isISOControl), "LABEL_INVALID");
        return clean;
    }

    @Override
    public String boundRoom(UUID id, long inviter, long invitee, String mode, boolean admit) {
        Room room = owned(inviter, id);
        synchronized (room) {
            Member host = member(room, inviter);
            require(host.id.equals(room.host) && room.mode.name().equals(mode), "HOST_ONLY");
            require(!room.closing && !room.banned.contains(invitee) && (room.phase == Phase.LOBBY || room.phase == Phase.FREE && (room.mode == Mode.FREE || room.mode == Mode.GUIDED)), "ROOM_UNAVAILABLE");
            require(room.members.size() < room.capacity(), "ROOM_FULL");
            if (admit && room.reservedFor != null) room.reservedFor.add(invitee);
            return room.code;
        }
    }

    private boolean hasCode(String code) {
        return rooms.values().stream().anyMatch(r -> r.code.equals(code));
    }

    @Override
    public boolean isOpen(String code) {
        return rooms.values().stream().anyMatch(r -> r.code.equals(code) && !r.closing);
    }

    private Member target(Room r, UUID id) {
        synchronized (r) {
            return r.members.values().stream().filter(m -> m.id.equals(id)).findFirst().orElseThrow(() -> fail(404, "MEMBER_NOT_FOUND"));
        }
    }

    private void hostAction(Room r, Command c, String action) {
        switch (action) {
            case "team" -> {
                Member target = target(r, c.target());
                synchronized (r) {
                    require(r.phase == Phase.LOBBY, "MATCH_STARTED");
                    require(c.team() != null && (c.team() == 0 || c.team() == 1), "TEAM_INVALID");
                    target.team = c.team();
                    target.ready = false;
                    changed(r);
                }
            }
            case "topic" -> {
                synchronized (r) {
                    require(r.phase != Phase.FINISHED, "MATCH_FINISHED");
                    r.topic = label(c.topic(), 120);
                    if (c.prompt() != null && c.prompt() >= 0 && c.prompt() < PROMPTS) r.prompt = c.prompt();
                    changed(r);
                }
            }
            case "round" -> {
                Member speaker = target(r, c.target());
                synchronized (r) {
                    require(Set.of(Phase.LOBBY, Phase.REVIEW, Phase.FREE).contains(r.phase), "ROUND_ACTIVE");
                    require(r.round < 6, "ROUND_LIMIT");
                    require(r.members.size() >= 2, "NEED_PLAYERS");
                    if (r.phase == Phase.LOBBY) {
                        require(r.members.values().stream().allMatch(m -> m.ready && m.online), "NEED_READY");
                        if (r.mode == Mode.DUEL || r.mode == Mode.TEAM) {
                            require(r.members.size() == r.capacity(), "NEED_PLAYERS");
                            require(r.members.values().stream().filter(m -> m.team == 0).count() == r.capacity() / 2, "TEAMS_UNBALANCED");
                        }
                    }
                    require(speaker.online && !speaker.moderated, "SPEAKER_UNAVAILABLE");
                    require(c.prompt() != null && c.prompt() >= 0 && c.prompt() < PROMPTS, "PROMPT_INVALID");
                }
                transition(r, Phase.PREPARE, speaker.id, now() + 20_000, () -> {
                    r.round++;
                    r.prompt = c.prompt();
                });
            }
            case "stop" -> {
                synchronized (r) {
                    require(r.phase == Phase.PREPARE || r.phase == Phase.TALK, "NO_ACTIVE_ROUND");
                }
                transition(r, Phase.REVIEW, null, 0);
            }
            case "free" -> {
                synchronized (r) {
                    require(r.phase != Phase.FINISHED, "MATCH_FINISHED");
                }
                transition(r, Phase.FREE, null, 0);
            }
            case "mute" -> {
                Member target = target(r, c.target());
                rotate(r, target, false);
                synchronized (r) {
                    target.moderated = Boolean.TRUE.equals(c.value());
                    changed(r);
                }
            }
            case "kick" -> {
                Member target = target(r, c.target());
                require(!target.id.equals(r.host), "HOST_CANNOT_KICK_SELF");
                remove(r, target, "REMOVED");
                synchronized (r) {
                    r.banned.add(target.user);
                }
            }
            case "award" -> {
                synchronized (r) {
                    require(r.phase == Phase.REVIEW, "REVIEW_REQUIRED");
                    require(c.team() != null && (c.team() == 0 || c.team() == 1) && c.points() != null && c.points() >= 0 && c.points() <= 3, "AWARD_INVALID");
                    require(Set.of("CLARITY", "RESPONSE", "TEAMWORK").contains(c.reason() == null ? "" : c.reason()), "RUBRIC_REQUIRED");
                    require(r.awards.stream().noneMatch(a -> a.round() == r.round && a.team() == c.team()), "ALREADY_SCORED");
                    r.awards.add(new Award(r.round, c.team(), c.points(), c.reason()));
                    if (c.team() == 0) r.coral += c.points();
                    else r.lagoon += c.points();
                    changed(r);
                }
            }
            case "end" -> {
                synchronized (r) {
                    require(r.phase != Phase.FINISHED, "MATCH_FINISHED");
                }
                transition(r, Phase.FINISHED, null, 0);
            }
            case "rematch" -> {
                synchronized (r) {
                    require(r.phase == Phase.FINISHED, "FINISH_FIRST");
                    r.phase = Phase.LOBBY;
                    r.round = 0;
                    r.awards.clear();
                    r.coral = r.lagoon = 0;
                    r.members.values().forEach(m -> m.ready = false);
                    changed(r);
                }
            }
            default -> throw fail(400, "ACTION_INVALID");
        }
    }

    /** Never hold the snapshot/movement monitor across a provider request. Control commands serialize per room only. */
    private void rotate(Room r, Member m, boolean broadcast) {
        String old;
        synchronized (r) {
            old = m.voiceId;
        }
        voice.remove(r.media, old);
        // Never pass !existed as neverJoined: a participant can talk up to 29s before reconciliation
        // and disconnect WebRTC before sending a control frame, causing RemoveParticipant to return 404.
        // Preserves ArenaUsage invariant: "Whatever cannot be proven is charged."
        usage.settle(r.media, old, now());
        synchronized (r) {
            if (Objects.equals(m.voiceId, old)) {
                m.voiceId = UUID.randomUUID().toString();
            }
            if (broadcast) changed(r);
        }
    }

    private void transition(Room r, Phase phase, UUID speaker, long deadline) {
        transition(r, phase, speaker, deadline, null);
    }

    private void transition(Room r, Phase phase, UUID speaker, long deadline, Runnable onCommit) {
        record Target(Member member, String oldVoiceId) {}
        List<Target> targets;
        synchronized (r) {
            targets = r.members.values().stream()
                    .filter(m -> allowed(r, m, r.phase, r.speaker) != allowed(r, m, phase, speaker))
                    .map(m -> new Target(m, m.voiceId))
                    .toList();
        }
        if (targets.size() == 1) {
            Target t = targets.getFirst();
            voice.remove(r.media, t.oldVoiceId());
            usage.settle(r.media, t.oldVoiceId(), now());
            synchronized (r) {
                if (Objects.equals(t.member().voiceId, t.oldVoiceId())) {
                    t.member().voiceId = UUID.randomUUID().toString();
                }
            }
        } else if (targets.size() > 1) {
            List<CompletableFuture<Boolean>> futures = new ArrayList<>(targets.size());
            for (Target t : targets) {
                futures.add(CompletableFuture.supplyAsync(() -> voice.remove(r.media, t.oldVoiceId()), voiceIo));
            }
            RuntimeException failure = null;
            boolean rotatedAny = false;
            for (int i = 0; i < targets.size(); i++) {
                Target t = targets.get(i);
                try {
                    futures.get(i).join();
                    usage.settle(r.media, t.oldVoiceId(), now());
                    synchronized (r) {
                        if (Objects.equals(t.member().voiceId, t.oldVoiceId())) {
                            t.member().voiceId = UUID.randomUUID().toString();
                            rotatedAny = true;
                        }
                    }
                } catch (CompletionException ce) {
                    RuntimeException cause = ce.getCause() instanceof RuntimeException re ? re : fail(503, "VOICE_UNAVAILABLE");
                    if (failure == null) failure = cause;
                }
            }
            if (failure != null) {
                if (rotatedAny) {
                    synchronized (r) {
                        changed(r);
                    }
                }
                throw failure;
            }
        }
        synchronized (r) {
            r.phase = phase;
            r.speaker = speaker;
            r.deadline = deadline;
            if (onCommit != null) onCommit.run();
            changed(r);
        }
    }

    private static double feetAt(Member m, long now) {
        if (m.jumpAt == 0) return m.supportY;
        double t = Math.max(0, now - m.jumpAt) / 1000.;
        return Math.max(m.supportY, m.jumpFloor + m.jumpSpeed * t - 6 * t * t);
    }

    private static void syncBoatOccupant(Boat b, Member m, String role, long now) {
        double offsetZ = "cruiser".equals(b.model)
                ? ("ROWER".equals(role) ? -0.54 : 1.48)
                : b.motor
                ? ("ROWER".equals(role) ? -0.54 : 1.64)
                : ("ROWER".equals(role) ? -0.18 : 0.90);
        m.x = b.x + Math.sin(b.yaw) * offsetZ;
        m.z = b.z + Math.cos(b.yaw) * offsetZ;
        m.yaw = b.motor || "ROWER".equals(role) ? b.yaw : normAngle(b.yaw + Math.PI);
        m.supportY = b.motor
                ? ("ROWER".equals(role) ? ArenaGeometry.WATER_Y + 0.31 : ArenaGeometry.WATER_Y + 0.805)
                : "sampan".equals(b.model)
                ? ArenaGeometry.WATER_Y + 0.363
                : BOAT_SEAT_Y;
        m.diveDepth = 0;
        m.jumpAt = 0;
        m.jumpHeld = false;
        m.lastMove = now;
        m.moved = true;
    }

    private static Member findByMemberId(Room r, UUID id) {
        if (id == null) return null;
        for (Member m : r.members.values()) {
            if (m.id.equals(id)) return m;
        }
        return null;
    }

    private void boardBoat(Room room, Member m, String requestedBoatId) {
        if (m.boat != null) return;
        long now = now();
        if (ArenaGeometry.isSwimming(m.x, m.z) && m.jumpAt != 0 && now - m.jumpAt >= 400) {
            m.jumpAt = 0;
        }
        require(feetAt(m, now) <= m.supportY + .12, "LAND_FIRST");
        require(m.artifact == null, "HANDS_FULL");
        Boat boat;
        if (requestedBoatId != null && !requestedBoatId.isBlank()) {
            boat = room.boats.get(requestedBoatId);
            if (boat == null) throw fail(404, "BOAT_NOT_FOUND");
            require(ArenaGeometry.canBoardBoat(boat.x, boat.z, boat.yaw, m.x, m.z, boat.hull, boat.model), "BOAT_OUT_OF_RANGE");
        } else {
            boat = room.boats.values().stream()
                    .filter(b -> ArenaGeometry.canBoardBoat(b.x, b.z, b.yaw, m.x, m.z, b.hull, b.model))
                    .filter(b -> b.rower == null || b.passenger == null)
                    .min(Comparator.comparingDouble(b -> ArenaGeometry.hullGap(b.x, b.z, b.yaw, m.x, m.z, b.hull)))
                    .orElseThrow(() -> fail(409, "NO_FREE_SEAT"));
        }
        String role;
        if (boat.rower == null) {
            boat.rower = m.id;
            boat.sequence = -1;
            boat.travelCredit = 2.2;
            boat.lastMove = now;
            role = "ROWER";
        } else if (boat.passenger == null) {
            boat.passenger = m.id;
            role = "PASSENGER";
        } else {
            throw fail(409, "NO_FREE_SEAT");
        }
        boat.emptySince = 0;
        m.seat = null;
        m.boat = boat.id;
        m.boatRole = role;
        syncBoatOccupant(boat, m, role, now);
        changed(room);
    }

    private void disembarkBoat(Room room, Member m) {
        if (m.boat == null) return;
        Boat boat = room.boats.get(m.boat);
        long now = now();
        if (boat == null) {
            m.boat = null;
            m.boatRole = null;
            changed(room);
            return;
        }
        require((!boat.motor && !boat.engine) || Math.abs(boat.speed) < 1.1, "SLOW_AT_DOCK");
        ArenaGeometry.Landing landing = ArenaGeometry.disembarkPoint(boat.x, boat.z, boat.yaw, boat.hull);
        require(landing != null, "NO_LANDING_NEARBY");
        releaseFromBoat(room, m, now);
        m.x = landing.x();
        m.z = landing.z();
        m.supportY = landing.y();
        m.diveDepth = 0;
        m.jumpAt = 0;
        m.jumpHeld = false;
        m.travelCredit = 1.4;
        m.lastMove = now;
        m.moved = true;
        changed(room);
    }

    private void jumpOverboard(Room room, Member m, Double preferSide) {
        if (m.boat == null) return;
        Boat boat = room.boats.get(m.boat);
        long now = now();
        if (boat == null) {
            m.boat = null;
            m.boatRole = null;
            changed(room);
            return;
        }
        double side = (preferSide != null && Double.isFinite(preferSide)) ? Math.clamp(preferSide, -1.0, 1.0) : 0.0;
        ArenaGeometry.Landing water = ArenaGeometry.overboardPoint(boat.x, boat.z, boat.yaw, boat.hull, m.boatRole, side);
        require(water != null, "NO_CLEAR_WATER");
        releaseFromBoat(room, m, now);
        m.x = water.x();
        m.z = water.z();
        m.supportY = ArenaGeometry.supportY(m.x, m.z);
        m.diveDepth = 0;
        m.jumpFloor = ArenaGeometry.WATER_Y + 0.42;
        m.jumpSpeed = 3.2;
        m.jumpAt = now;
        m.jumpHeld = false;
        m.travelCredit = 2.4;
        m.lastMove = now;
        m.moved = true;
        changed(room);
    }

    /** Only the rower, only a hull that is really wedged, never further than 4 m. */
    private void freeBoat(Room room, Member m) {
        require(m.boat != null && "ROWER".equals(m.boatRole), "NOT_ROWING");
        Boat boat = room.boats.get(m.boat);
        require(boat != null && m.id.equals(boat.rower), "NOT_ROWING");
        ArenaGeometry.HullClearance clear = (px, pz, py) -> ArenaGeometry.boatClear(px, pz, py, boat.hull) && clearOfBoats(room, boat, px, pz, py);
        require(ArenaGeometry.boatWedged(boat.x, boat.z, boat.yaw, clear), "BOAT_NOT_STUCK");
        double[] free = ArenaGeometry.boatRescue(boat.x, boat.z, boat.yaw, clear);
        require(free != null, "NO_CLEAR_WATER");
        long now = now();
        boat.x = free[0];
        boat.z = free[1];
        boat.yaw = normAngle(free[2]);
        boat.sequence = -1;
        boat.travelCredit = 2.2;
        boat.lastMove = now;
        boat.moved = true;
        syncBoatOccupant(boat, m, "ROWER", now);
        if (boat.passenger != null) {
            Member pax = findByMemberId(room, boat.passenger);
            if (pax != null) syncBoatOccupant(boat, pax, "PASSENGER", now);
        }
        changed(room);
    }

    private void placeItem(Room room, Member m, String tableId) {
        ItemState rest = room.items.get(m.artifact);
        if (rest == null) return;
        if (tableId == null || tableId.isBlank()) {
            require(Math.hypot(m.x - rest.x(), m.z - rest.z()) <= 2.9 && ArenaGeometry.inReach(m.x, m.z, rest.x(), rest.z()), "PLACE_ON_TABLE");
            return;
        }
        var table = ArenaGeometry.LAYOUT.furniture().stream()
                .filter(f -> "table".equals(f.kind()) && f.id().equals(tableId)).findFirst()
                .orElseThrow(() -> fail(409, "PLACE_ON_TABLE"));
        require(Math.hypot(m.x - table.x(), m.z - table.z()) <= 1.9 && ArenaGeometry.inReach(m.x, m.z, table.x(), table.z())
                && feetAt(m, now()) <= m.supportY + .12, "OUT_OF_RANGE");
        double top = ArenaGeometry.floor(table.x(), table.z()), c = Math.cos(table.yaw()), s = Math.sin(table.yaw());
        double[][] slots = {{0, 0}, {.34, 0}, {-.34, 0}, {0, .34}, {0, -.34}};
        double[] best = null;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (double[] slot : slots) {
            double x = table.x() + c * slot[0] + s * slot[1], z = table.z() - s * slot[0] + c * slot[1];
            boolean taken = room.items.values().stream().anyMatch(o -> !o.id().equals(rest.id()) && Math.hypot(o.x() - x, o.z() - z) < .3);
            double d = Math.hypot(m.x - x, m.z - z);
            if (!taken && d < bestDistance) { bestDistance = d; best = new double[]{x, z}; }
        }
        require(best != null, "TABLE_FULL");
        room.items.put(rest.id(), new ItemState(rest.id(), table.id(), best[0], best[1], top, normAngle(m.yaw)));
    }

    private void releaseFromBoat(Room room, Member m, long now) {
        if (m.boat == null) return;
        Boat boat = room.boats.get(m.boat);
        m.boat = null;
        m.boatRole = null;
        if (boat == null) return;
        if (m.id.equals(boat.rower)) {
            boat.rower = null;
            boat.engine = false;
            boat.speed = boat.steering = boat.throttle = boat.yawRate = 0;
            if (boat.passenger != null) {
                Member promoted = findByMemberId(room, boat.passenger);
                if (promoted != null) {
                    boat.rower = promoted.id;
                    boat.passenger = null;
                    boat.sequence = -1;
                    boat.travelCredit = 2.2;
                    boat.lastMove = now;
                    promoted.boatRole = "ROWER";
                    syncBoatOccupant(boat, promoted, "ROWER", now);
                } else {
                    boat.passenger = null;
                }
            }
        } else if (m.id.equals(boat.passenger)) {
            boat.passenger = null;
        }
        if (boat.rower == null && boat.passenger == null) {
            boat.emptySince = now;
        }
    }

    private void toggleBeacon(Room room, Member m, String beaconId) {
        var inter = ArenaGeometry.LAYOUT.interactables().stream()
                .filter(i -> "beacon".equals(i.kind()))
                .filter(i -> beaconId != null && !beaconId.isBlank() ? i.id().equals(beaconId) : Math.hypot(m.x - i.x(), m.z - i.z()) <= i.range() + .8)
                .filter(i -> Math.hypot(m.x - i.x(), m.z - i.z()) <= i.range() + .8 && ArenaGeometry.inReach(m.x, m.z, i.x(), i.z()))
                .min(Comparator.comparingDouble(i -> Math.hypot(m.x - i.x(), m.z - i.z())))
                .orElseThrow(() -> fail(409, "OUT_OF_RANGE"));
        if (!room.beacons.remove(inter.id())) room.beacons.add(inter.id());
        changed(room);
    }

    private void standOffSeat(Member m, String seatId) {
        ArenaGeometry.Seat current = seatId == null
                ? null
                : ArenaGeometry.SEATS.stream().filter(s -> s.id().equals(seatId)).findFirst().orElse(null);
        if (current != null) {
            double fx = Math.sin(current.yaw()), fz = Math.cos(current.yaw());
            double rx = Math.cos(current.yaw()), rz = -Math.sin(current.yaw());
            double[][] offsets = {
                    {0.82, 0.0},
                    {0.82, -0.45},
                    {0.82, 0.45},
                    {0.98, 0.0},
                    {-0.82, 0.0}
            };
            for (double[] off : offsets) {
                double candX = current.x() + fx * off[0] + rx * off[1];
                double candZ = current.z() + fz * off[0] + rz * off[1];
                double[] stepped = ArenaGeometry.step(current.x(), current.z(), candX, candZ, current.y());
                double supY = ArenaGeometry.supportY(stepped[0], stepped[1]);
                if (ArenaGeometry.walkable(stepped[0], stepped[1], supY) && supY < current.y() - 0.18) {
                    m.x = stepped[0];
                    m.z = stepped[1];
                    m.yaw = normAngle(current.yaw());
                    m.seat = null;
                    m.supportY = supY;
                    m.diveDepth = 0;
                    return;
                }
            }
            double fallbackX = current.x() + fx * 0.82;
            double fallbackZ = current.z() + fz * 0.82;
            m.x = fallbackX;
            m.z = fallbackZ;
            m.yaw = normAngle(current.yaw());
        }
        m.seat = null;
        m.supportY = ArenaGeometry.supportY(m.x, m.z);
        m.diveDepth = 0;
    }

    private void setSeated(Room room, Member m, boolean sit, String seatId) {
        if (m.boat != null || sit == (m.seat != null)) return;
        if (sit) {
            require(!ArenaGeometry.isSwimming(m.x, m.z) && feetAt(m, now()) <= m.supportY + .09, "LAND_FIRST");
            require(m.artifact == null, "HANDS_FULL");
            if (GROUND_SEAT.equals(seatId)) {
                require(ArenaGeometry.dryWalkable(m.x, m.z), "LAND_FIRST");
                m.seat = GROUND_SEAT;
                m.supportY = ArenaGeometry.floor(m.x, m.z);
                m.diveDepth = 0;
            } else {
                var seat = ArenaGeometry.SEATS.stream()
                        .filter(s -> (seatId == null || s.id().equals(seatId)) && ArenaGeometry.inReach(m.x, m.z, s.x(), s.z()))
                        .filter(s -> Math.hypot(m.x - s.x(), m.z - s.z()) <= 2.20 && Math.abs(m.supportY - s.y()) <= 1.1)
                        .filter(s -> room.members.values().stream().noneMatch(other -> s.id().equals(other.seat)))
                        .min(Comparator.comparingDouble(s -> Math.hypot(m.x - s.x(), m.z - s.z())))
                        .orElseThrow(() -> fail(409, "NO_FREE_SEAT"));
                m.seat = seat.id();
                m.x = seat.x();
                m.z = seat.z();
                m.yaw = seat.yaw();
                m.supportY = seat.y();
                m.diveDepth = 0;
            }
        } else {
            standOffSeat(m, m.seat);
        }
        m.jumpAt = 0;
        m.jumpHeld = false;
        m.lastMove = now();
        m.moved = true;
        changed(room);
    }

    private static boolean clearOfBoats(Room r, Boat self, double x, double z, double yaw) {
        for (Boat other : r.boats.values()) {
            if (self != other && ArenaGeometry.hullsOverlap(x, z, yaw, other.x, other.z, other.yaw, self.hull, other.hull)) return false;
        }
        return true;
    }

    private void row(Room r, Member m, Command c) {
        if (m.boat == null || !"ROWER".equals(m.boatRole)) return;
        Boat boat = r.boats.get(m.boat);
        if (boat == null || !m.id.equals(boat.rower)) return;
        long now = now();
        if (now - boat.lastMove < 65) return;
        if (c.sequence() == null || c.x() == null || c.z() == null || c.yaw() == null
                || !Double.isFinite(c.x()) || !Double.isFinite(c.z()) || !Double.isFinite(c.yaw())) {
            throw fail(400, "POSITION_INVALID");
        }
        if (c.sequence() <= boat.sequence) return;
        m.motionClient = true;
        boolean helmDriven = boat.motor || (boat.canEngine && boat.engine && c.throttle() != null && c.steering() != null);
        if (helmDriven) {
            driveMotor(r, boat, c, now);
        } else {
            double limit = ArenaGeometry.BOAT_LIMIT;
            double x = Math.clamp(c.x(), -limit, limit), z = Math.clamp(c.z(), -limit, limit);
            boat.travelCredit = Math.min(5.6, boat.travelCredit + Math.max(0, now - boat.lastMove) * .0054);
            double dx = x - boat.x, dz = z - boat.z, distance = Math.hypot(dx, dz);
            if (distance > boat.travelCredit) {
                dx *= boat.travelCredit / distance;
                dz *= boat.travelCredit / distance;
            }
            double targetYaw = normAngle(c.yaw());
            double yaw = ArenaGeometry.boatClear(boat.x, boat.z, targetYaw, boat.hull) && clearOfBoats(r, boat, boat.x, boat.z, targetYaw) ? targetYaw : boat.yaw;
            double[] next = ArenaGeometry.boatStep(boat.x, boat.z, yaw, boat.x + dx, boat.z + dz,
                    (px, pz, py) -> ArenaGeometry.boatClear(px, pz, py, boat.hull) && clearOfBoats(r, boat, px, pz, py));
            boat.travelCredit = Math.max(0, boat.travelCredit - Math.hypot(next[0] - boat.x, next[1] - boat.z));
            boat.x = next[0];
            boat.z = next[1];
            boat.yaw = yaw;
            if (c.aux() != null && Double.isFinite(c.aux())) {
                boat.rowPhase = c.aux();
            }
        }
        boat.lastMove = now;
        boat.sequence = c.sequence();
        boat.moved = true;

        syncBoatOccupant(boat, m, "ROWER", now);
        if (boat.passenger != null) {
            Member pax = findByMemberId(r, boat.passenger);
            if (pax != null) syncBoatOccupant(boat, pax, "PASSENGER", now);
        }
    }

    /** Integrate bounded helm inputs against server time. The motor never accepts a client-supplied pose. */
    private void driveMotor(Room r, Boat b, Command c, long now) {
        if (c.throttle() == null || c.steering() == null || !Double.isFinite(c.throttle()) || !Double.isFinite(c.steering()))
            throw fail(400, "POSITION_INVALID");
        b.throttle = b.engine ? Math.clamp(c.throttle(), -1., 1.) : 0.;
        b.steering = Math.clamp(c.steering(), -1., 1.);
        double elapsed = Math.clamp((now - b.lastMove) * .001, 0, .3);
        int steps = Math.max(1, (int) Math.ceil(elapsed * 60));
        double dt = elapsed / steps;
        double fwdPower = "sampan".equals(b.model) ? 6.8 : "cruiser".equals(b.model) ? 9.6 : 11.3;
        double revPower = "sampan".equals(b.model) ? 3.8 : 5.6;
        ArenaGeometry.HullClearance clear = (x, z, yaw) -> ArenaGeometry.boatClear(x, z, yaw, b.hull) && clearOfBoats(r, b, x, z, yaw);
        for (int i = 0; i < steps; i++) {
            b.speed += ((b.throttle < 0 ? revPower : fwdPower) * b.throttle - (.28 + .012 * Math.abs(b.speed)) * b.speed) * dt;
            double authority = Math.tanh(b.speed / 3.) / (1. + .018 * Math.abs(b.speed));
            b.yawRate += (-b.steering * authority - b.yawRate) * (1. - Math.exp(-3.5 * dt));
            double nextYaw = normAngle(b.yaw + b.yawRate * dt);
            if (clear.clear(b.x, b.z, nextYaw)) b.yaw = nextYaw;
            double sx = Math.sin(b.yaw), sz = Math.cos(b.yaw);
            double[] p = ArenaGeometry.boatStep(b.x, b.z, b.yaw, b.x + sx * b.speed * dt, b.z + sz * b.speed * dt, clear);
            b.speed = dt > 0 ? ((p[0] - b.x) * sx + (p[1] - b.z) * sz) / dt : b.speed;
            b.x = p[0];
            b.z = p[1];
        }
    }

    private void move(Room r, Member m, Command c) {
        long now = now();
        if ("OBSERVE".equals(m.gesture) && m.gestureUntil > now && Math.hypot((c.x() == null ? m.x : c.x()) - m.x, (c.z() == null ? m.z : c.z()) - m.z) > .05) {
            m.gestureUntil = 0;
            changed(r);
        }
        if (now - m.lastMove < 65 || m.seat != null || m.boat != null) return;
        if (c.sequence() == null || c.x() == null || c.z() == null || c.yaw() == null || !Double.isFinite(c.x()) || !Double.isFinite(c.z()) || !Double.isFinite(c.yaw()))
            throw fail(400, "POSITION_INVALID");
        if (c.sequence() <= m.sequence) return;
        double limit = ArenaGeometry.PLAYER_LIMIT;
        double x = Math.clamp(c.x(), -limit, limit), z = Math.clamp(c.z(), -limit, limit);
        m.motionClient = c.value() != null;
        boolean wasSwimming = ArenaGeometry.isSwimming(m.x, m.z);
        double feet = wasSwimming ? m.supportY : feetAt(m, now);
        boolean jump = Boolean.TRUE.equals(c.value());
        if (jump && !m.jumpHeld) {
            if (wasSwimming) {
                ArenaGeometry.Landing climb = ArenaGeometry.climbOutPoint(m.x, m.z);
                if (climb != null) {
                    m.x = climb.x();
                    m.z = climb.z();
                    m.supportY = climb.y();
                    m.diveDepth = 0;
                    m.jumpAt = 0;
                    m.jumpHeld = true;
                    m.yaw = normAngle(c.yaw());
                    m.lastMove = now;
                    m.sequence = c.sequence();
                    m.moved = true;
                    return;
                }
            } else if (feet <= m.supportY + .015) {
                m.jumpAt = now;
                m.jumpFloor = m.supportY;
                m.jumpSpeed = 5;
            }
        }
        m.jumpHeld = jump;
        // Server-clock distance credit survives bunching and coalescing. No per-packet bonus.
        m.travelCredit = Math.min(3.6, m.travelCredit + Math.max(0, now - m.lastMove) * .0036);
        double dx = x - m.x, dz = z - m.z, distance = Math.hypot(dx, dz);
        if (distance > m.travelCredit) {
            dx *= m.travelCredit / distance;
            dz *= m.travelCredit / distance;
        }
        double[] position = ArenaGeometry.step(m.x, m.z, m.x + dx, m.z + dz, feet);
        m.travelCredit = Math.max(0, m.travelCredit - Math.hypot(position[0] - m.x, position[1] - m.z));
        m.x = position[0];
        m.z = position[1];
        double nextSupport = ArenaGeometry.supportY(m.x, m.z);
        boolean nowSwimming = ArenaGeometry.isSwimming(m.x, m.z);
        if (nowSwimming) {
            m.jumpAt = 0;
            double maxDive = Math.min(18.0, Math.max(0.0, ArenaGeometry.waterDepth(m.x, m.z) - 0.95));
            m.diveDepth = (c.aux() != null && Double.isFinite(c.aux())) ? Math.clamp(c.aux(), 0.0, maxDive) : 0.0;
        } else {
            m.diveDepth = 0.0;
            if (nextSupport + .12 < m.supportY && feet <= m.supportY + .015 && !jump) {
                m.jumpFloor = feet;
                m.jumpSpeed = 0;
                m.jumpAt = now;
            }
        }
        m.supportY = nextSupport;
        m.yaw = normAngle(c.yaw());
        m.lastMove = now;
        m.sequence = c.sequence();
        m.moved = true;
    }

    public VoiceTicket ticket(long uid, UUID id) {
        Room r = owned(uid, id);
        if (!r.control.tryLock()) throw fail(409, "ROOM_BUSY");
        try {
            long now = now();
            String media;
            String identity;
            boolean canPublish;
            synchronized (r) {
                Member m = member(r, uid);
                require(!stopped && m.online && !m.revokePending && now - m.seen < LEASE_MS && !r.closing && now - r.created < ROOM_MS, "CONNECTION_REQUIRED");
                checkVoiceRateLimit(uid, m, now);
                media = r.media;
                identity = m.voiceId;
                canPublish = allowed(r, m, r.phase, r.speaker);
            }
            usage.open(media, identity, now);
            String token;
            try {
                synchronized (r) {
                    Member m = member(r, uid);
                    require(!stopped && m.online && !m.revokePending && !r.closing && Objects.equals(m.voiceId, identity), "CONNECTION_REQUIRED");
                    canPublish = allowed(r, m, r.phase, r.speaker);
                }
                token = voice.token(media, identity, canPublish);
            } catch (RuntimeException e) {
                try {
                    usage.rollback(media, identity, now);
                } catch (RuntimeException ignored) {}
                throw e;
            }
            boolean stillValid;
            synchronized (r) {
                Member m = r.members.get(uid);
                stillValid = !stopped && m != null && m.online && !m.revokePending && !r.closing && Objects.equals(m.voiceId, identity);
                if (stillValid) m.voiceIssued = now;
            }
            if (!stillValid) {
                voice.evictIdentity(media, identity);
                try {
                    usage.rollback(media, identity, now);
                } catch (RuntimeException ignored) {}
                throw fail(409, "CONNECTION_REQUIRED");
            }
            recordVoiceTicket(uid, now);
            return new VoiceTicket(voice.url(), token, identity, now + 120_000);
        } finally {
            r.control.unlock();
        }
    }

    private void remove(Room r, Member m, String type) {
        String oldVoiceId;
        synchronized (r) {
            oldVoiceId = m.voiceId;
        }
        voice.remove(r.media, oldVoiceId);
        usage.settle(r.media, oldVoiceId, now());
        synchronized (r) {
            releaseFromBoat(r, m, now());
            r.members.remove(m.user);
            active.remove(m.user, r.id);
            events.send(m.principal, m.session, new Event(type, null, null, null));
            if (m.id.equals(r.speaker)) {
                r.phase = Phase.REVIEW;
                r.deadline = 0;
                r.speaker = null;
            }
            if (m.id.equals(r.host))
                r.host = r.members.values().stream().findFirst().map(x -> x.id).orElse(null);
            changed(r);
            if (r.members.isEmpty()) r.closing = true;
        }
        if (r.closing) {
            voice.close(r.media);
            usage.closeRoom(r.media, now());
            rooms.remove(r.id, r);
        }
    }

    public void disconnected(String session) {
        long now = now();
        markSessionDisconnected(session);
        for (Room r : rooms.values())
            synchronized (r) {
                for (Member m : r.members.values()) {
                    if (Objects.equals(m.pendingSession, session)) {
                        m.pendingSessionDisconnected = true;
                    }
                    if (Objects.equals(m.session, session)) {
                        markMemberOfflineLocked(r, m, now);
                        changed(r);
                    }
                }
            }
    }

    void tick() {
        long now = now();
        for (Room r : rooms.values()) {
            synchronized (r) {
                for (Boat b : r.boats.values()) {
                    if (b.rower == null && b.passenger == null && b.emptySince > 0 && now - b.emptySince >= BOAT_RETURN_MS) {
                        if (!clearOfBoats(r, b, b.homeX, b.homeZ, b.homeYaw)) continue;
                        if (Math.hypot(b.x - b.homeX, b.z - b.homeZ) > 0.1 || Math.abs(normAngle(b.yaw - b.homeYaw)) > 0.05) {
                            b.x = b.homeX;
                            b.z = b.homeZ;
                            b.yaw = b.homeYaw;
                            b.rowPhase = 0;
                            b.sequence = -1;
                            b.lastMove = now;
                            changed(r);
                        }
                        b.emptySince = 0;
                    }
                }
                if (!r.pending) {
                    var moved = r.members.values().stream().filter(m -> m.moved)
                            .map(m -> new Pose(m.id, m.sequence, m.lastMove, m.x, m.z, m.yaw, m.jumpAt, m.jumpFloor, m.supportY, m.jumpSpeed, m.seat, m.boat, m.boatRole, m.diveDepth)).toList();
                    var movedBoats = r.boats.values().stream().filter(b -> b.moved).map(Boat::toState).toList();
                    if (r.dirty || !moved.isEmpty() || !movedBoats.isEmpty()) {
                        var delta = new Event("MOTION", null, null, null, new Motion(r.id, now, moved, movedBoats));
                        for (Member m : r.members.values())
                            if (m.online) {
                                var event = r.dirty || !m.motionClient ? new Event("STATE", null, null, snapshot(r, m)) : delta;
                                events.send(m.principal, m.session, event);
                            }
                        r.members.values().forEach(m -> m.moved = false);
                        r.boats.values().forEach(b -> b.moved = false);
                        r.dirty = false;
                    }
                }
                if (r.reservedFor != null && !r.opened && r.members.isEmpty() && now > r.reservedUntil) {
                    rooms.remove(r.id, r);
                    continue;
                }
                boolean work = r.closing || now - r.created > ROOM_MS || r.deadline > 0 && now >= r.deadline || r.members.values().stream().anyMatch(m -> m.revokePending || now - m.seen > LEASE_MS);
                if (!work || r.pending || now < r.retryAfter) continue;
                r.pending = true;
            }
            try {
                submit(() -> {
                    if (!r.control.tryLock()) {
                        synchronized (r) {
                            r.pending = false;
                        }
                        return;
                    }
                    try {
                        if (r.closing) {
                            voice.close(r.media);
                            usage.closeRoom(r.media, now());
                            rooms.remove(r.id, r);
                            return;
                        }
                        List<Member> disconnected;
                        synchronized (r) {
                            disconnected = r.members.values().stream().filter(m -> m.revokePending).toList();
                        }
                        for (Member m : disconnected) {
                            rotate(r, m, false);
                            synchronized (r) {
                                m.revokePending = false;
                                changed(r);
                            }
                        }
                        List<Member> expired;
                        long tickNow = now();
                        synchronized (r) {
                            expired = r.members.values().stream().filter(m -> tickNow - m.seen > LEASE_MS || tickNow - r.created > ROOM_MS).toList();
                        }
                        for (Member m : expired) remove(r, m, "EXPIRED");
                        long deadlineNow = now();
                        synchronized (r) {
                            if (r.deadline <= 0 || deadlineNow < r.deadline || r.closing) return;
                        }
                        if (r.phase == Phase.PREPARE) transition(r, Phase.TALK, r.speaker, now() + 60_000);
                        else if (r.phase == Phase.TALK) transition(r, Phase.REVIEW, null, 0);
                    } catch (RuntimeException ignored) {
                        synchronized (r) {
                            r.retryAfter = now() + 5000;
                        }
                    } finally {
                        synchronized (r) {
                            r.pending = false;
                        }
                        r.control.unlock();
                    }
                });
            } catch (RuntimeException e) {
                synchronized (r) {
                    r.pending = false;
                }
            }
        }
    }

    @jakarta.annotation.PreDestroy
    public void close() {
        stopped = true;
        timer.shutdownNow();
        controls.shutdownNow();
        voiceIo.shutdownNow();
        try {
            controls.awaitTermination(5, TimeUnit.SECONDS);
            voiceIo.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        for (Room r : rooms.values())
            try {
                voice.close(r.media);
                usage.closeRoom(r.media, now());
            } catch (RuntimeException ignored) {}
        rooms.clear();
        active.clear();
    }
}
