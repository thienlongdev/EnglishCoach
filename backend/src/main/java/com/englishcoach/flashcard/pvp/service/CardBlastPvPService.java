package com.englishcoach.flashcard.pvp.service;

import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.englishcoach.flashcard.pvp.dto.PvPMessage;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.*;
import com.englishcoach.flashcard.pvp.engine.ScheduleBuilder;
import com.englishcoach.flashcard.pvp.engine.ScheduleBuilder.WordSource;
import com.englishcoach.flashcard.pvp.model.*;
import com.englishcoach.flashcard.pvp.util.RoomCodeGenerator;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import com.englishcoach.flashcard.pvp.entity.*;
import com.englishcoach.flashcard.pvp.repository.*;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Service
@Slf4j
public class CardBlastPvPService {

    private final SimpMessagingTemplate messagingTemplate;
    private final FlashcardRepository flashcardRepository;
    private final DictionaryRepository dictionaryRepository;
    private final VocabDeckRepository vocabDeckRepository;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private PvpMatchRepository pvpMatchRepository;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private PvpPlayerStatsRepository pvpPlayerStatsRepository;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private PvpMissedWordRepository pvpMissedWordRepository;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private PvpRatingRepository pvpRatingRepository;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

    public CardBlastPvPService(
            @org.springframework.context.annotation.Lazy SimpMessagingTemplate messagingTemplate,
            FlashcardRepository flashcardRepository,
            DictionaryRepository dictionaryRepository,
            VocabDeckRepository vocabDeckRepository
    ) {
        this.messagingTemplate = messagingTemplate;
        this.flashcardRepository = flashcardRepository;
        this.dictionaryRepository = dictionaryRepository;
        this.vocabDeckRepository = vocabDeckRepository;
    }

    @org.springframework.beans.factory.annotation.Autowired
    public CardBlastPvPService(
            @org.springframework.context.annotation.Lazy SimpMessagingTemplate messagingTemplate,
            FlashcardRepository flashcardRepository,
            DictionaryRepository dictionaryRepository,
            VocabDeckRepository vocabDeckRepository,
            @org.springframework.beans.factory.annotation.Autowired(required = false) PvpMatchRepository pvpMatchRepository,
            @org.springframework.beans.factory.annotation.Autowired(required = false) PvpPlayerStatsRepository pvpPlayerStatsRepository,
            @org.springframework.beans.factory.annotation.Autowired(required = false) PvpMissedWordRepository pvpMissedWordRepository,
            @org.springframework.beans.factory.annotation.Autowired(required = false) PvpRatingRepository pvpRatingRepository
    ) {
        this.messagingTemplate = messagingTemplate;
        this.flashcardRepository = flashcardRepository;
        this.dictionaryRepository = dictionaryRepository;
        this.vocabDeckRepository = vocabDeckRepository;
        this.pvpMatchRepository = pvpMatchRepository;
        this.pvpPlayerStatsRepository = pvpPlayerStatsRepository;
        this.pvpMissedWordRepository = pvpMissedWordRepository;
        this.pvpRatingRepository = pvpRatingRepository;
    }

    private final ConcurrentHashMap<String, CardBlastRoom> activeRooms = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> userActiveRooms = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Map<Integer, Long>> botHitSchedules = new ConcurrentHashMap<>();
    private static final long MAX_CLIENT_CLOCK_LEAD_MS = 2500L;
    private static final long MAX_CLIENT_SPAWN_LEAD_MS = 500L;
    private final ConcurrentHashMap<String, Long> lastClientHitServerMs = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> lastClientHitTMs = new ConcurrentHashMap<>();

    private void clearRoomHitTracking(String roomCode) {
        if (roomCode == null) return;
        String prefix = roomCode + ":";
        lastClientHitServerMs.keySet().removeIf(k -> k.startsWith(prefix));
        lastClientHitTMs.keySet().removeIf(k -> k.startsWith(prefix));
    }

    // Keep repeated room creation off the remote DB/projection allocation path.
    // Short-lived, bounded snapshots; personal vocabulary is always owner-scoped.
    private record VocabularySnapshot(long expiresAtMs, List<WordSource> words) {}
    private final Map<String, VocabularySnapshot> vocabularySnapshots = new LinkedHashMap<>(16, .75f, true);
    private static final long VOCABULARY_SNAPSHOT_TTL_MS = 60_000;
    private static final int MAX_VOCABULARY_SNAPSHOTS = 16;

    private final SecureRandom secureRandom = new SecureRandom();

    public ConcurrentHashMap<String, CardBlastRoom> getActiveRooms() {
        return activeRooms;
    }

    // Shares CREATE's monitor so reconnect cannot observe half-created membership.
    public synchronized String getActiveRoomCodeForUser(String userId) {
        return userActiveRooms.get(userId);
    }

    public boolean isUserInRoom(String rawRoomCode, String userId) {
        if (rawRoomCode == null || userId == null) return false;
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        return room != null && room.isParticipant(userId);
    }

    public CardBlastRoom getRoom(String rawRoomCode) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        return activeRooms.get(roomCode);
    }

    private void sendToPlayerUserQueue(PlayerState player, String destination, Object payload) {
        if (player == null || player.getUserId() == null) return;
        String identity = player.getPrincipalName() != null && !player.getPrincipalName().isBlank()
                ? player.getPrincipalName() : player.getUserId();
        messagingTemplate.convertAndSendToUser(identity, destination, payload);
    }

    public CardBlastRoom createRoom(String userId, String displayName, String avatar, CreateRoomRequest req) {
        return createRoom(userId, displayName, avatar, req, null);
    }

    public CardBlastRoom createRoom(String userId, String displayName, String avatar, CreateRoomRequest req, String principalName) {
        return createRoom(userId, displayName, avatar, req, principalName, null);
    }

    public synchronized CardBlastRoom createRoom(String userId, String displayName, String avatar, CreateRoomRequest req, String principalName, String sessionId) {
        long enteredMs = System.currentTimeMillis();
        String currentCode = userActiveRooms.get(userId);
        CardBlastRoom currentRoom = currentCode != null ? activeRooms.get(currentCode) : null;
        if (currentRoom != null) {
            synchronized (currentRoom.getRoomLock()) {
                if (currentRoom.getStatus() == RoomStatus.WAITING && currentRoom.isHost(userId)) {
                    PlayerState host = currentRoom.getHost();
                    if (sessionId != null) host.setSessionId(sessionId);
                    if (principalName != null) host.setPrincipalName(principalName);
                    host.setConnected(true);host.setDisconnectDeadlineMs(null);
                    return currentRoom;
                }
                if (currentRoom.getStatus() == RoomStatus.IN_GAME || currentRoom.getStatus() == RoomStatus.COUNTDOWN) {
                    throw new IllegalStateException("Rời phòng hiện tại trước khi tạo phòng mới.");
                }
            }
        }
        if (activeRooms.size() >= CardBlastPvPConstants.MAX_ACTIVE_ROOMS) {
            throw new IllegalStateException("Max active rooms limit reached (" + CardBlastPvPConstants.MAX_ACTIVE_ROOMS + ")");
        }

        // Leave any existing active room
        leaveUserCurrentRoom(userId);

        if (req.getDeckId() == null && req.getDeckSlug() != null && !req.getDeckSlug().isBlank()) {
            try {
                vocabDeckRepository.findBySlug(req.getDeckSlug()).ifPresent(d -> {
                    req.setDeckId(d.getId());
                    if (req.getDeckTitle() == null || req.getDeckTitle().isBlank() || req.getDeckTitle().equals("Flashcards") || req.getDeckTitle().equals("Bộ từ vựng")) {
                        req.setDeckTitle(d.getTitle());
                    }
                });
            } catch (Exception ex) {
                log.warn("[PVP] Failed to lookup deck by slug {}: {}", req.getDeckSlug(), ex.getMessage());
            }
        }

        String roomCode = generateUniqueRoomCode();
        long codeCreatedMs = System.currentTimeMillis();
        long seed = secureRandom.nextLong();
        String direction = (req.getDirection() != null && req.getDirection().equalsIgnoreCase("EN_VI")) ? "EN_VI" : "VI_EN";
        RoomMode mode = req.getMode() != null ? req.getMode() : RoomMode.HUMAN;
        BotLevel botLevel = req.getBotLevel() != null ? req.getBotLevel() : BotLevel.NORMAL;

        int speedLevel = (req.getSpeedLevel() != null && req.getSpeedLevel() >= 1 && req.getSpeedLevel() <= 5) ? req.getSpeedLevel() : 2;
        String hintLevel = (req.getHintLevel() != null && (req.getHintLevel().equalsIgnoreCase("EASY") || req.getHintLevel().equalsIgnoreCase("HARD"))) ? req.getHintLevel().toUpperCase() : "NORMAL";

        List<WordSource> words = loadWordsForDeck(userId, req.getDeckId(), req.getDeckSlug(), direction);
        List<ScheduledWord> schedule = ScheduleBuilder.buildSchedule(words, seed, direction, speedLevel, hintLevel);

        boolean isBot = (mode == RoomMode.BOT);
        PlayerState host = PlayerState.builder()
                .userId(userId)
                .principalName(principalName)
                .sessionId(sessionId)
                .displayName(displayName != null && !displayName.isBlank() ? displayName : "Player 1")
                .avatar(avatar)
                .ready(isBot)
                .connected(true)
                .hp(CardBlastPvPConstants.STARTING_HP)
                .mana(0)
                .skills(new ArrayList<>(CardBlastPvPConstants.DEFAULT_SKILLS))
                .score(0)
                .streak(0)
                .bestStreak(0)
                .hits(0)
                .misses(0)
                .attacksSent(0)
                .attacksReceived(0)
                .goldenCaptured(0)
                .skillsUsed(0)
                .totalReactionTimeMs(0L)
                .reactionCount(0)
                .build();

        PlayerState guest = null;
        if (isBot) {
            guest = PlayerState.builder()
                    .userId("bot-echo")
                    .displayName("Bot Echo")
                    .avatar("/assets/Whale.svg")
                    .ready(true)
                    .connected(true)
                    .hp(CardBlastPvPConstants.STARTING_HP)
                    .mana(0)
                    .skills(Collections.emptyList())
                    .score(0)
                    .streak(0)
                    .bestStreak(0)
                    .hits(0)
                    .misses(0)
                    .attacksSent(0)
                    .attacksReceived(0)
                    .goldenCaptured(0)
                    .skillsUsed(0)
                    .totalReactionTimeMs(0L)
                    .reactionCount(0)
                    .build();
        }

        long now = System.currentTimeMillis();
        RoomStatus initialStatus = isBot ? RoomStatus.COUNTDOWN : RoomStatus.WAITING;
        Long matchStartMs = isBot ? (now + CardBlastPvPConstants.COUNTDOWN_DURATION_MS) : null;

        CardBlastRoom room = CardBlastRoom.builder()
                .roomCode(roomCode)
                .deckId(req.getDeckId())
                .deckTitle(req.getDeckTitle() != null ? req.getDeckTitle() : "Flashcards")
                .direction(direction)
                .mode(mode)
                .botLevel(botLevel)
                .speedLevel(speedLevel)
                .hintLevel(hintLevel)
                .status(initialStatus)
                .matchStartServerMs(matchStartMs)
                .suddenDeath(false)
                .host(host)
                .guest(guest)
                .seed(seed)
                .schedule(schedule)
                .createdAt(now)
                .lastActivityAt(now)
                .build();

        activeRooms.put(roomCode, room);
        userActiveRooms.put(userId, roomCode);
        log.info("[PVP TIMING] room={} serviceEnteredMs={} codeCreatedMs={} roomCreatedMs={}",
                roomCode, enteredMs, codeCreatedMs, System.currentTimeMillis());

        if (isBot) {
            planBotHits(room);
            broadcastStartCountdown(room);
        }

        broadcastRoomState(room);
        log.info("[PVP] Room {} created by user {} (mode={}, deck={}, status={})", roomCode, userId, mode, req.getDeckTitle(), initialStatus);
        return room;
    }

    public CardBlastRoom joinRoom(String userId, String displayName, String avatar, String rawRoomCode) {
        return joinRoom(userId, displayName, avatar, rawRoomCode, null);
    }

    public CardBlastRoom joinRoom(String userId, String displayName, String avatar, String rawRoomCode, String principalName) {
        return joinRoom(userId, displayName, avatar, rawRoomCode, principalName, null);
    }

    public CardBlastRoom joinRoom(String userId, String displayName, String avatar, String rawRoomCode, String principalName, String sessionId) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) {
            throw new IllegalArgumentException("Room not found: " + roomCode);
        }

        synchronized (room.getRoomLock()) {
            if (room.isParticipant(userId)) {
                PlayerState existing = room.getPlayer(userId);
                if (sessionId != null) existing.setSessionId(sessionId);
                existing.setConnected(true);
                existing.setDisconnectDeadlineMs(null);
                if (principalName != null && existing.getPrincipalName() == null) {
                    existing.setPrincipalName(principalName);
                }
                userActiveRooms.put(userId, roomCode);
                room.touch();
                broadcastRoomState(room);
                return room;
            }

            // Permit joining if room is in FINISHED state and Host is present
            if (room.getStatus() == RoomStatus.FINISHED) {
                if (room.getHost() != null && room.getHost().isConnected()) {
                    log.info("[PVP] Room {} in FINISHED state is being joined by user {}. Resetting to WAITING.", roomCode, userId);
                    if (room.getGuest() != null && !room.getGuest().getUserId().equals(userId)) {
                        userActiveRooms.remove(room.getGuest().getUserId());
                        room.setGuest(null);
                    }
                    resetRoomToWaiting(room);
                } else {
                    throw new IllegalStateException("Cannot join room in state " + room.getStatus());
                }
            }

            if (room.getStatus() != RoomStatus.WAITING) {
                throw new IllegalStateException("Cannot join room in state " + room.getStatus());
            }

            if (room.getGuest() != null) {
                if (!room.getGuest().isConnected()) {
                    userActiveRooms.remove(room.getGuest().getUserId());
                    room.setGuest(null);
                } else {
                    throw new IllegalStateException("Room is already full");
                }
            }

            // Leave any previous room
            leaveUserCurrentRoom(userId);

            PlayerState guest = PlayerState.builder()
                    .userId(userId)
                    .principalName(principalName)
                .sessionId(sessionId)
                    .displayName(displayName != null && !displayName.isBlank() ? displayName : "Player 2")
                    .avatar(avatar)
                    .ready(false)
                    .connected(true)
                    .hp(CardBlastPvPConstants.STARTING_HP)
                    .mana(0)
                    .skills(new ArrayList<>(CardBlastPvPConstants.DEFAULT_SKILLS))
                    .score(0)
                    .streak(0)
                    .bestStreak(0)
                    .hits(0)
                    .misses(0)
                    .attacksSent(0)
                    .attacksReceived(0)
                    .goldenCaptured(0)
                    .skillsUsed(0)
                    .totalReactionTimeMs(0L)
                    .reactionCount(0)
                    .build();

            room.setGuest(guest);
            room.touch();
            userActiveRooms.put(userId, roomCode);

            broadcastRoomState(room);
            log.info("[PVP] User {} joined room {}", userId, roomCode);
            return room;
        }
    }

    public void setReady(String userId, String rawRoomCode, boolean ready) {
        setReady(userId, rawRoomCode, ready, null);
    }

    public void setReady(String userId, String rawRoomCode, boolean ready, List<String> skills) {
        setReady(userId, rawRoomCode, ready, skills, null);
    }

    // ── Echo Sentinel (10 §BX): a match against a person is ranked only through acknowledged strict attempts ──────────
    private com.englishcoach.sentinel.SentinelService sentinel;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSentinel(com.englishcoach.sentinel.SentinelService sentinel) { this.sentinel = sentinel; sentinel.onVoid(this::onSentinelVoid); }

    /** A void decided by the page or the sweeper: during the match it is a forfeit (the loss counts); before it, not ready. */
    private void onSentinelVoid(com.englishcoach.sentinel.SentinelAttempt attempt) {
        for (CardBlastRoom room : activeRooms.values()) {
            for (PlayerState p : java.util.Arrays.asList(room.getHost(), room.getGuest())) {
                if (p == null || p.getSentinel() != attempt) continue;
                synchronized (room.getRoomLock()) {
                    if (room.getStatus() == RoomStatus.IN_GAME || room.getStatus() == RoomStatus.COUNTDOWN) {
                        terminateMatchForfeit(room, p.getUserId());
                    } else if (room.getStatus() == RoomStatus.WAITING) {
                        p.setReady(false); p.setSentinel(null); broadcastRoomState(room);
                    }
                }
                return;
            }
        }
    }

    /**
     * Ranked only if both players acknowledged a strict attempt and every player who did not forfeit completes it verified.
     * The forfeiting player's attempt (voided or not) never cancels their loss: leaving the screen cannot escape Elo.
     */
    private boolean sentinelAllowsRanking(CardBlastRoom room, String reason, String loserId) {
        if (sentinel == null || room.getMode() != RoomMode.HUMAN) return true;
        boolean ok = true;
        for (PlayerState p : java.util.Arrays.asList(room.getHost(), room.getGuest())) {
            if (p == null) continue;
            var attempt = p.getSentinel();
            if (attempt == null) { ok = false; continue; }
            boolean forfeiter = "FORFEIT".equals(reason) && p.getUserId().equals(loserId);
            if (forfeiter) {
                if (!attempt.terminal()) sentinel.voidFromGame(attempt, com.englishcoach.sentinel.SentinelAttempt.State.VOIDED_ABANDONED, "FORFEIT", "MATCH_LEFT");
                continue;
            }
            var change = sentinel.complete(attempt);
            if (change == null || change.to() != com.englishcoach.sentinel.SentinelAttempt.State.COMPLETED_VERIFIED) ok = false;
            sentinel.persistLater(change);
        }
        return ok;
    }

    public void setReady(String userId, String rawRoomCode, boolean ready, List<String> skills, String sentinelHandle) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) return;

        synchronized (room.getRoomLock()) {
            if (room.getStatus() != RoomStatus.WAITING) return;
            PlayerState player = room.getPlayer(userId);
            if (player == null) return;

            player.setReady(ready);
            if (sentinel != null && room.getMode() == RoomMode.HUMAN && ready && sentinelHandle != null) {
                var attempt = sentinel.bind(Long.parseLong(userId), sentinelHandle, com.englishcoach.sentinel.SentinelPolicy.CARD_BLAST_PVP, roomCode);
                if (attempt != null) player.setSentinel(attempt);
            }

            if (skills != null && !skills.isEmpty()) {
                List<String> validated = new ArrayList<>();
                for (String s : skills) {
                    if (s != null) {
                        String upper = s.trim().toUpperCase();
                        if (CardBlastPvPConstants.VALID_SKILLS.contains(upper) && !validated.contains(upper)) {
                            validated.add(upper);
                        }
                    }
                }
                if (validated.size() == 3) {
                    player.setSkills(validated);
                } else if (player.getSkills() == null || player.getSkills().isEmpty()) {
                    player.setSkills(new ArrayList<>(CardBlastPvPConstants.DEFAULT_SKILLS));
                }
            } else if (player.getSkills() == null || player.getSkills().isEmpty()) {
                player.setSkills(new ArrayList<>(CardBlastPvPConstants.DEFAULT_SKILLS));
            }

            room.touch();

            boolean hostReady = room.getHost() != null && room.getHost().isReady();
            boolean guestReady = room.getGuest() != null && room.getGuest().isReady();

            if (hostReady && guestReady) {
                startCountdown(room);
            } else {
                broadcastRoomState(room);
            }
        }
    }

    public void startCountdown(CardBlastRoom room) {
        room.setStatus(RoomStatus.COUNTDOWN);
        room.setSuddenDeath(false);
        long now = System.currentTimeMillis();
        long startMs = now + CardBlastPvPConstants.COUNTDOWN_DURATION_MS;
        room.setMatchStartServerMs(startMs);
        room.touch();

        if (room.getMode() == RoomMode.BOT) {
            planBotHits(room);
        }
        if (sentinel != null && room.getMode() == RoomMode.HUMAN) {
            for (PlayerState p : java.util.Arrays.asList(room.getHost(), room.getGuest()))
                if (p != null && p.getSentinel() != null) sentinel.playStarted(p.getSentinel(), room.getRoomCode());
        }

        broadcastStartCountdown(room);
        broadcastRoomState(room);
        log.info("[PVP] Room {} started countdown (startAt={})", room.getRoomCode(), startMs);
    }

    public void broadcastStartCountdown(CardBlastRoom room) {
        StartCountdownPayload payload = StartCountdownPayload.builder()
                .roomCode(room.getRoomCode())
                .matchStartServerMs(room.getMatchStartServerMs() != null ? room.getMatchStartServerMs() : System.currentTimeMillis() + CardBlastPvPConstants.COUNTDOWN_DURATION_MS)
                .seed(room.getSeed())
                .schedule(room.getSchedule())
                .host(room.getHost())
                .guest(room.getGuest())
                .speedLevel(room.getSpeedLevel())
                .hintLevel(room.getHintLevel())
                .suddenDeath(false)
                .build();

        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                PvPMessage.of("START_COUNTDOWN", room.getRoomCode(), payload));
    }

    public boolean applyHit(String rawRoomCode, String userId, int seq, long tMs) {
        if (tMs < 0) {
            log.warn("[PVP] Reject hit seq={} for user {}: negative tMs={}", seq, userId, tMs);
            return false;
        }
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) return false;

        synchronized (room.getRoomLock()) {
            // Strictly IN_GAME only: reject hits submitted during COUNTDOWN, WAITING, or FINISHED.
            if (room.getStatus() != RoomStatus.IN_GAME) {
                log.warn("[PVP] Reject hit seq={} for user {} in room {}: invalid phase {}",
                        seq, userId, roomCode, room.getStatus());
                return false;
            }

            PlayerState player = room.getPlayer(userId);
            if (player == null) return false;

            if (room.getMatchStartServerMs() == null) {
                return false;
            }
            long nowMs = System.currentTimeMillis();
            long serverElapsedMs = nowMs - room.getMatchStartServerMs();
            if (serverElapsedMs < 0) {
                log.warn("[PVP] Reject hit seq={} for user {} in room {}: match not yet started on server clock (elapsed={}ms)",
                        seq, userId, roomCode, serverElapsedMs);
                return false;
            }
            long effectiveTMs = (tMs == 0L) ? serverElapsedMs : tMs;
            if (effectiveTMs > serverElapsedMs + MAX_CLIENT_CLOCK_LEAD_MS) {
                log.warn("[PVP] Reject hit seq={} for user {} in room {}: forged future tMs={} > serverElapsedMs={} + {}",
                        seq, userId, roomCode, effectiveTMs, serverElapsedMs, MAX_CLIENT_CLOCK_LEAD_MS);
                return false;
            }

            return executeHitInternal(room, player, seq, effectiveTMs, true, serverElapsedMs, nowMs);
        }
    }

    public boolean castSkill(String userId, String rawRoomCode, String rawSkillId) {
        if (rawRoomCode == null || rawSkillId == null) return false;
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null || room.getStatus() != RoomStatus.IN_GAME) return false;

        String skillId = rawSkillId.trim().toUpperCase();

        synchronized (room.getRoomLock()) {
            PlayerState caster = room.getPlayer(userId);
            if (caster == null) return false;

            // Bot Echo does not cast skills
            if ("bot-echo".equalsIgnoreCase(caster.getUserId())) return false;

            // Check if caster owns this skill in loadout
            if (caster.getSkills() == null || !caster.getSkills().contains(skillId)) {
                log.warn("[PVP SKILL] User {} tried to cast unequipped skill {}", userId, skillId);
                return false;
            }

            // Check mana cost
            int cost = CardBlastPvPConstants.getSkillCost(skillId);
            if (caster.getMana() < cost && (caster.getMana() + 5 >= cost)) {
                caster.setMana(cost);
            }
            if (caster.getMana() < cost) {
                log.warn("[PVP SKILL] User {} insufficient mana for {}: {} < {}", userId, skillId, caster.getMana(), cost);
                return false;
            }

            long now = System.currentTimeMillis();
            // Global 1s cooldown to prevent double packet race
            if (now - caster.getLastSkillCastMs() < 1000L) {
                log.warn("[PVP SKILL] User {} skill on cooldown", userId);
                return false;
            }

            caster.setMana(caster.getMana() - cost);
            caster.setSkillsUsed(caster.getSkillsUsed() + 1);
            caster.setLastSkillCastMs(now);
            room.touch();

            long matchStart = room.getMatchStartServerMs() != null ? room.getMatchStartServerMs() : now;
            long matchNowMs = Math.max(0, now - matchStart);

            switch (skillId) {
                case "ECHO_CHAIN":
                    caster.setEchoChainArmed(true);
                    log.info("[PVP SKILL] User {} armed ECHO_CHAIN in room {}", userId, roomCode);
                    break;

                case "SLOW_MO":
                    caster.setDeadlineBonusMs(caster.getDeadlineBonusMs() + 5000L);
                    messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                            PvPMessage.of("DEADLINE_UPDATE", room.getRoomCode(),
                                    new DeadlineUpdatePayload(userId, 5000L)));
                    log.info("[PVP SKILL] User {} cast SLOW_MO (+5s) in room {}", userId, roomCode);
                    break;

                case "EMP_BLAST":
                    // 1. Clears all active words on caster's screen
                    List<Integer> clearedSeqs = new ArrayList<>();
                    for (ScheduledWord sw : room.getSchedule()) {
                        long spawn = sw.getSpawnAtMs();
                        long exp = spawn + sw.getFallDurationMs() + caster.getDeadlineBonusMs();
                        if (matchNowMs >= spawn && matchNowMs <= exp && !caster.getResolvedSeqs().contains(sw.getSeq())) {
                            caster.getResolvedSeqs().add(sw.getSeq());
                            clearedSeqs.add(sw.getSeq());
                        }
                    }
                    for (ScheduledWord gw : new ArrayList<>(room.getActiveGarbageWords().values())) {
                        if (userId.equals(gw.getTargetPlayerId())) {
                            room.getActiveGarbageWords().remove(gw.getSeq());
                            caster.getResolvedSeqs().add(gw.getSeq());
                            clearedSeqs.add(gw.getSeq());
                        }
                    }
                    // 2. Heal caster +15 HP (up to MAX_HP 100)
                    caster.setHp(Math.min(CardBlastPvPConstants.MAX_HP, caster.getHp() + 15));
                    // 3. Dispatch 1 attack to opponent
                    triggerAttack(room, caster);
                    messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                            PvPMessage.of("EMP_BLAST_CAST", room.getRoomCode(),
                                    new EmpBlastPayload(userId, clearedSeqs)));
                    log.info("[PVP SKILL] User {} cast EMP_BLAST in room {}, healed +15 HP (now {}), cleared {} words",
                            userId, roomCode, caster.getHp(), clearedSeqs.size());
                    break;

                case "FOG":
                    PlayerState opponent = room.getOpponent(userId);
                    if (opponent != null) {
                        opponent.setFogActiveUntilMs(now + 5000L);
                        if (room.getMode() == RoomMode.BOT) {
                            Map<Integer, Long> botHits = botHitSchedules.get(room.getRoomCode());
                            if (botHits != null) {
                                for (Map.Entry<Integer, Long> entry : botHits.entrySet()) {
                                    if (entry.getValue() > matchNowMs) {
                                        entry.setValue(entry.getValue() + 1500L);
                                    }
                                }
                            }
                        }
                        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                                PvPMessage.of("FOG_APPLIED", room.getRoomCode(),
                                        new FogAppliedPayload(opponent.getUserId(), 5000L)));
                        log.info("[PVP SKILL] User {} cast FOG on {} for 5s in room {}", userId, opponent.getUserId(), roomCode);
                    }
                    break;

                case "SHIELD":
                    caster.setShieldActiveUntilMs(now + 8000L);
                    PendingAttack pendingTargetingCaster = room.getPendingAttacks().stream()
                            .filter(a -> a.getToUserId().equals(userId) && !a.isParried())
                            .findFirst()
                            .orElse(null);
                    if (pendingTargetingCaster != null) {
                        room.getPendingAttacks().remove(pendingTargetingCaster);
                        caster.setShieldActiveUntilMs(null);
                        caster.setAttacksDeflected(caster.getAttacksDeflected() + 1);
                        ShieldAbsorbedPayload absorbed = ShieldAbsorbedPayload.builder()
                                .targetPlayerId(caster.getUserId())
                                .attackerId(pendingTargetingCaster.getFromUserId())
                                .attackId(pendingTargetingCaster.getAttackId())
                                .build();
                        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                                PvPMessage.of("ATTACK_ABSORBED", room.getRoomCode(), absorbed));
                        log.info("[PVP SKILL] Shield immediately absorbed pending attack {} for user {} in room {}",
                                pendingTargetingCaster.getAttackId(), userId, roomCode);
                    } else {
                        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                                PvPMessage.of("SHIELD_ACTIVATED", room.getRoomCode(),
                                        new ShieldActivatedPayload(userId, 8000L)));
                        log.info("[PVP SKILL] User {} activated SHIELD for 8s in room {}", userId, roomCode);
                    }
                    break;

                default:
                    log.warn("[PVP SKILL] Unknown skill {}", skillId);
                    return false;
            }

            broadcastLiveState(room, null);
            return true;
        }
    }

    public void handleClientGameOver(String userId, String rawRoomCode, String reason) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) return;

        synchronized (room.getRoomLock()) {
            if (room.getStatus() != RoomStatus.IN_GAME && room.getStatus() != RoomStatus.COUNTDOWN) return;
            PlayerState player = room.getPlayer(userId);
            if (player == null) return;

            // A client reports its view, never HP or the terminal rule. Rendering
            // delays and background tabs must not manufacture a loss.
            checkMatchCompletion(room);
        }
    }

    public boolean executeHit(CardBlastRoom room, PlayerState player, int seq, long tMs) {
        return executeHitInternal(room, player, seq, tMs, false, -1L, System.currentTimeMillis());
    }

    private boolean validateWordHitTiming(
            CardBlastRoom room,
            PlayerState player,
            ScheduledWord word,
            long effectiveTMs,
            long deadlineBonusMs,
            boolean clientSubmitted,
            long serverElapsedMs,
            long nowMs,
            String kind
    ) {
        long spawnAt = word.getSpawnAtMs();
        long fallDuration = word.getFallDurationMs();
        int wordLen = Math.max(1, word.getWord() != null ? word.getWord().length() : 3);
        long minReactionMs = CardBlastPvPConstants.ANTI_MACRO_MS_PER_CHAR * wordLen;

        if (clientSubmitted) {
            long maxValidTMs = spawnAt + fallDuration + deadlineBonusMs + CardBlastPvPConstants.HIT_GRACE_WINDOW_MS;
            if (effectiveTMs < spawnAt || effectiveTMs > maxValidTMs) {
                log.warn("[PVP] Reject {} hit seq={} for user {}: tMs={} outside [{}, {}]",
                        kind, word.getSeq(), player.getUserId(), effectiveTMs, spawnAt, maxValidTMs);
                return false;
            }
            if (serverElapsedMs < spawnAt - MAX_CLIENT_SPAWN_LEAD_MS) {
                log.warn("[PVP] Reject {} hit seq={} for user {}: serverElapsedMs={} before spawnAt={}",
                        kind, word.getSeq(), player.getUserId(), serverElapsedMs, spawnAt);
                return false;
            }
            if (serverElapsedMs > spawnAt + fallDuration + deadlineBonusMs + MAX_CLIENT_CLOCK_LEAD_MS) {
                log.warn("[PVP] Reject {} hit seq={} for user {}: serverElapsedMs={} past expiry",
                        kind, word.getSeq(), player.getUserId(), serverElapsedMs);
                return false;
            }
            if ((effectiveTMs - spawnAt) < minReactionMs
                    || (serverElapsedMs - spawnAt + MAX_CLIENT_SPAWN_LEAD_MS) < minReactionMs) {
                log.warn("[PVP] Reject {} hit seq={} for user {}: anti-macro violation (tMsDelta={}, serverDelta={}, min={})",
                        kind, word.getSeq(), player.getUserId(), (effectiveTMs - spawnAt), (serverElapsedMs - spawnAt), minReactionMs);
                return false;
            }
            String hitKey = room.getRoomCode() + ":" + player.getUserId();
            Long prevServerMs = lastClientHitServerMs.get(hitKey);
            if (prevServerMs != null && (nowMs - prevServerMs) < minReactionMs) {
                log.warn("[PVP] Reject {} hit seq={} for user {}: server inter-hit anti-macro violation ({}ms < {}ms)",
                        kind, word.getSeq(), player.getUserId(), (nowMs - prevServerMs), minReactionMs);
                return false;
            }
            Long prevHitTMs = lastClientHitTMs.get(hitKey);
            if (prevHitTMs != null && (effectiveTMs - prevHitTMs) < minReactionMs) {
                log.warn("[PVP] Reject {} hit seq={} for user {}: client tMs inter-hit anti-macro violation ({}ms < {}ms)",
                        kind, word.getSeq(), player.getUserId(), (effectiveTMs - prevHitTMs), minReactionMs);
                return false;
            }
            return true;
        }

        long minValidTMs = Math.max(0L, spawnAt - CardBlastPvPConstants.HIT_GRACE_WINDOW_MS);
        long maxValidTMs = spawnAt + fallDuration + deadlineBonusMs + CardBlastPvPConstants.HIT_GRACE_WINDOW_MS;
        if (effectiveTMs < minValidTMs || effectiveTMs > maxValidTMs) {
            log.warn("[PVP] Reject {} hit seq={} for user {}: tMs={} outside [{}, {}]",
                    kind, word.getSeq(), player.getUserId(), effectiveTMs, minValidTMs, maxValidTMs);
            return false;
        }
        if ((effectiveTMs - spawnAt) < minReactionMs) {
            log.warn("[PVP] Reject {} hit seq={} for user {}: anti-macro violation (elapsed={} < min={})",
                    kind, word.getSeq(), player.getUserId(), (effectiveTMs - spawnAt), minReactionMs);
            return false;
        }
        return true;
    }

    private void recordClientHit(CardBlastRoom room, PlayerState player, long nowMs, long effectiveTMs) {
        String hitKey = room.getRoomCode() + ":" + player.getUserId();
        lastClientHitServerMs.put(hitKey, nowMs);
        lastClientHitTMs.put(hitKey, effectiveTMs);
    }

    private boolean executeHitInternal(
            CardBlastRoom room,
            PlayerState player,
            int seq,
            long tMs,
            boolean clientSubmitted,
            long serverElapsedMs,
            long nowMs
    ) {
        if (player.getResolvedSeqs().contains(seq)) {
            return false;
        }

        long effectiveTMs = tMs;
        if (!clientSubmitted && effectiveTMs <= 0 && room.getMatchStartServerMs() != null) {
            effectiveTMs = Math.max(0, System.currentTimeMillis() - room.getMatchStartServerMs());
            log.info("[PVP] Hit seq={} from user {} had tMs<=0; fallback to server elapsed tMs={}",
                    seq, player.getUserId(), effectiveTMs);
        }

        int manaGain = player.isLastStand() ? CardBlastPvPConstants.MANA_GAIN_LAST_STAND : CardBlastPvPConstants.MANA_GAIN_NORMAL;

        // 1. Golden Word Hit
        if (room.getActiveGoldenWord() != null && seq == room.getActiveGoldenWord().getSeq()) {
            if (room.getGoldenWordClaimedBy() != null) {
                return false;
            }
            ScheduledWord goldenWord = room.getActiveGoldenWord();
            long spawnAt = goldenWord.getSpawnAtMs();
            if (!validateWordHitTiming(room, player, goldenWord, effectiveTMs, 0L, clientSubmitted, serverElapsedMs, nowMs, "golden")) {
                return false;
            }

            room.setGoldenWordClaimedBy(player.getUserId());
            room.setActiveGoldenWord(null);
            if (clientSubmitted) {
                recordClientHit(room, player, nowMs, effectiveTMs);
            }

            player.getResolvedSeqs().add(seq);
            player.setHits(player.getHits() + 1);
            player.setStreak(player.getStreak() + 1);
            player.setBestStreak(Math.max(player.getBestStreak(), player.getStreak()));
            player.setGoldenCaptured(player.getGoldenCaptured() + 1);
            player.setMana(Math.min(CardBlastPvPConstants.MAX_MANA, player.getMana() + manaGain));

            long reaction = Math.max(0, effectiveTMs - spawnAt);
            player.setTotalReactionTimeMs(player.getTotalReactionTimeMs() + reaction);
            player.setReactionCount(player.getReactionCount() + 1);

            int earnedScore = CardBlastPvPConstants.BASE_SCORE_PER_HIT * Math.max(1, player.getStreak()) * CardBlastPvPConstants.GOLDEN_WORD_SCORE_MULTIPLIER;
            player.setScore(player.getScore() + earnedScore);
            player.setHp(Math.min(CardBlastPvPConstants.MAX_HP, player.getHp() + CardBlastPvPConstants.HIT_GAIN_HP));
            player.getMissedWordIds().remove(goldenWord.getWordId());
            room.touch();

            // Parry any incoming attack on this player
            checkAndExecuteParry(room, player);

            // Instant attack on opponent
            triggerAttack(room, player);

            checkAndExecuteEchoChain(room, player, seq, effectiveTMs);

            GoldenTakenPayload goldenPayload = GoldenTakenPayload.builder()
                    .seq(seq)
                    .winnerId(player.getUserId())
                    .winnerName(player.getDisplayName())
                    .word(goldenWord.getWord())
                    .build();
            messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                    PvPMessage.of("GOLDEN_TAKEN", room.getRoomCode(), goldenPayload));

            LastHitInfo lastHit = LastHitInfo.builder()
                    .userId(player.getUserId())
                    .seq(seq)
                    .tMs(effectiveTMs)
                    .earnedScore(earnedScore)
                    .build();
            broadcastLiveState(room, lastHit);
            checkMatchCompletion(room);
            return true;
        }

        // 2. Garbage Word Hit
        if (room.getActiveGarbageWords().containsKey(seq)) {
            ScheduledWord gw = room.getActiveGarbageWords().get(seq);
            if (!player.getUserId().equals(gw.getTargetPlayerId())) {
                return false;
            }
            long spawnAt = gw.getSpawnAtMs();
            if (!validateWordHitTiming(room, player, gw, effectiveTMs, 0L, clientSubmitted, serverElapsedMs, nowMs, "garbage")) {
                return false;
            }

            room.getActiveGarbageWords().remove(seq);
            if (clientSubmitted) {
                recordClientHit(room, player, nowMs, effectiveTMs);
            }

            player.getResolvedSeqs().add(seq);
            player.setHits(player.getHits() + 1);
            player.setStreak(player.getStreak() + 1);
            player.setBestStreak(Math.max(player.getBestStreak(), player.getStreak()));
            player.setMana(Math.min(CardBlastPvPConstants.MAX_MANA, player.getMana() + manaGain));

            long reaction = Math.max(0, effectiveTMs - spawnAt);
            player.setTotalReactionTimeMs(player.getTotalReactionTimeMs() + reaction);
            player.setReactionCount(player.getReactionCount() + 1);

            int earnedScore = CardBlastPvPConstants.BASE_SCORE_PER_HIT * Math.max(1, player.getStreak());
            player.setScore(player.getScore() + earnedScore);
            player.setHp(Math.min(CardBlastPvPConstants.MAX_HP, player.getHp() + CardBlastPvPConstants.HIT_GAIN_HP));
            player.getMissedWordIds().remove(gw.getWordId());
            room.touch();

            if (player.getStreak() > 0 && player.getStreak() % CardBlastPvPConstants.ATTACK_STREAK_MILESTONE == 0) {
                checkAndExecuteParry(room, player);
                triggerAttack(room, player);
            }

            checkAndExecuteEchoChain(room, player, seq, effectiveTMs);

            LastHitInfo lastHit = LastHitInfo.builder()
                    .userId(player.getUserId())
                    .seq(seq)
                    .tMs(effectiveTMs)
                    .earnedScore(earnedScore)
                    .build();
            broadcastLiveState(room, lastHit);
            checkMatchCompletion(room);
            return true;
        }

        // 3. Regular Scheduled Word Hit
        if (seq <= 0 || seq > room.getSchedule().size()) {
            return false;
        }

        ScheduledWord word = room.getSchedule().get(seq - 1);
        long spawnAt = word.getSpawnAtMs();
        if (!validateWordHitTiming(room, player, word, effectiveTMs, player.getDeadlineBonusMs(), clientSubmitted, serverElapsedMs, nowMs, "regular")) {
            return false;
        }

        // Apply Hit
        if (clientSubmitted) {
            recordClientHit(room, player, nowMs, effectiveTMs);
        }
        player.getResolvedSeqs().add(seq);
        player.setHits(player.getHits() + 1);
        player.setStreak(player.getStreak() + 1);
        player.setBestStreak(Math.max(player.getBestStreak(), player.getStreak()));
        player.setMana(Math.min(CardBlastPvPConstants.MAX_MANA, player.getMana() + manaGain));

        long reaction = Math.max(0, effectiveTMs - spawnAt);
        player.setTotalReactionTimeMs(player.getTotalReactionTimeMs() + reaction);
        player.setReactionCount(player.getReactionCount() + 1);

        int earnedScore = CardBlastPvPConstants.BASE_SCORE_PER_HIT * Math.max(1, player.getStreak());
        player.setScore(player.getScore() + earnedScore);
        player.setHp(Math.min(CardBlastPvPConstants.MAX_HP, player.getHp() + CardBlastPvPConstants.HIT_GAIN_HP));
        player.getMissedWordIds().remove(word.getWordId());
        room.touch();

        if (player.getStreak() > 0 && player.getStreak() % CardBlastPvPConstants.ATTACK_STREAK_MILESTONE == 0) {
            checkAndExecuteParry(room, player);
            triggerAttack(room, player);
        }

        checkAndExecuteEchoChain(room, player, seq, effectiveTMs);

        LastHitInfo lastHit = LastHitInfo.builder()
                .userId(player.getUserId())
                .seq(seq)
                .tMs(effectiveTMs)
                .earnedScore(earnedScore)
                .build();

        broadcastLiveState(room, lastHit);

        checkMatchCompletion(room);
        return true;
    }

    private void checkAndExecuteEchoChain(CardBlastRoom room, PlayerState player, int seq, long tMs) {
        if (!player.isEchoChainArmed()) return;

        ScheduledWord nearest = null;
        long minDiff = Long.MAX_VALUE;
        for (ScheduledWord sw : room.getSchedule()) {
            if (sw.getSeq() != seq && !player.getResolvedSeqs().contains(sw.getSeq())) {
                long spawn = sw.getSpawnAtMs();
                long exp = spawn + sw.getFallDurationMs() + player.getDeadlineBonusMs();
                if (tMs >= spawn - 400 && tMs <= exp + 800) {
                    long diff = Math.abs(sw.getSpawnAtMs() - tMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        nearest = sw;
                    }
                }
            }
        }

        // Also check active garbage words targeting this player
        if (nearest == null && room.getActiveGarbageWords() != null) {
            for (ScheduledWord gw : room.getActiveGarbageWords().values()) {
                if (gw.getSeq() != seq && player.getUserId().equals(gw.getTargetPlayerId()) && !player.getResolvedSeqs().contains(gw.getSeq())) {
                    long spawn = gw.getSpawnAtMs();
                    long exp = spawn + gw.getFallDurationMs() + player.getDeadlineBonusMs();
                    if (tMs >= spawn - 400 && tMs <= exp + 800) {
                        nearest = gw;
                        break;
                    }
                }
            }
        }

        if (nearest != null) {
            player.setEchoChainArmed(false);
            player.getResolvedSeqs().add(nearest.getSeq());
            player.setHits(player.getHits() + 1);
            player.setStreak(player.getStreak() + 1);
            player.setBestStreak(Math.max(player.getBestStreak(), player.getStreak()));

            int chainScore = CardBlastPvPConstants.BASE_SCORE_PER_HIT * Math.max(1, player.getStreak());
            player.setScore(player.getScore() + chainScore);
            player.setHp(Math.min(CardBlastPvPConstants.MAX_HP, player.getHp() + CardBlastPvPConstants.HIT_GAIN_HP));
            player.getMissedWordIds().remove(nearest.getWordId());
            if (room.getActiveGarbageWords() != null) {
                room.getActiveGarbageWords().remove(nearest.getSeq());
            }

            EchoChainDetonatedPayload chainPayload = EchoChainDetonatedPayload.builder()
                    .userId(player.getUserId())
                    .detonatedSeq(nearest.getSeq())
                    .word(nearest.getWord())
                    .earnedScore(chainScore)
                    .build();
            messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                    PvPMessage.of("ECHO_CHAIN_DETONATED", room.getRoomCode(), chainPayload));
            log.info("[PVP SKILL] Echo Chain detonated seq={} for user {} in room {}", nearest.getSeq(), player.getUserId(), room.getRoomCode());
        }
    }

    public void applyMiss(CardBlastRoom room, PlayerState player, int seq) {
        if (player.getResolvedSeqs().contains(seq)) {
            return;
        }

        player.getResolvedSeqs().add(seq);
        player.setMisses(player.getMisses() + 1);
        player.setStreak(0);

        int damage = room.isSuddenDeath()
                ? CardBlastPvPConstants.MISS_DAMAGE_HP * CardBlastPvPConstants.SUDDEN_DEATH_DAMAGE_MULTIPLIER
                : CardBlastPvPConstants.MISS_DAMAGE_HP;

        player.setHp(Math.max(0, player.getHp() - damage));

        if (seq >= 1 && seq <= room.getSchedule().size()) {
            player.getMissedWordIds().add(room.getSchedule().get(seq - 1).getWordId());
        } else if (room.getActiveGarbageWords().containsKey(seq)) {
            ScheduledWord gw = room.getActiveGarbageWords().remove(seq);
            if (gw != null) {
                player.getMissedWordIds().add(gw.getWordId());
            }
        }

        room.touch();

        if (player.getHp() > 0 && player.getHp() <= CardBlastPvPConstants.LAST_STAND_HP_THRESHOLD && !player.isLastStand()) {
            player.setLastStand(true);
            player.setLastStandTriggered(true);
            messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                    PvPMessage.of("LAST_STAND", room.getRoomCode(), new LastStandPayload(player.getUserId())));
            log.info("[PVP] Last Stand latched for {} in room {}", player.getUserId(), room.getRoomCode());
        }

        log.debug("[PVP] Auto-miss seq={} applied to user {} (HP={}, SuddenDeath={})",
                seq, player.getUserId(), player.getHp(), room.isSuddenDeath());

        if (player.getHp() <= 0) {
            terminateMatch(room, "KO");
        } else {
            checkMatchCompletion(room);
        }
    }

    private void checkMatchCompletion(CardBlastRoom room) {
        if (room.getStatus() != RoomStatus.IN_GAME) return;

        PlayerState host = room.getHost();
        PlayerState guest = room.getGuest();

        if (host != null && host.getHp() <= 0) {
            terminateMatch(room, "KO");
            return;
        }
        if (guest != null && guest.getHp() <= 0) {
            terminateMatch(room, "KO");
            return;
        }

        boolean hostDone = host != null && room.getSchedule().stream().allMatch(w -> host.getResolvedSeqs().contains(w.getSeq()));
        boolean guestDone = guest == null || room.getSchedule().stream().allMatch(w -> guest.getResolvedSeqs().contains(w.getSeq()));

        boolean pendingRemaining = !room.getPendingAttacks().isEmpty() || !room.getActiveGarbageWords().isEmpty();

        if (hostDone && guestDone && !pendingRemaining) {
            terminateMatch(room, "WORDS_EXHAUSTED");
        }
    }

    public void terminateMatch(CardBlastRoom room, String reason) {
        synchronized (room.getRoomLock()) {
            terminateMatchInternal(room, reason, null);
        }
    }

    public void terminateMatchForfeit(CardBlastRoom room, String forfeitedUserId) {
        synchronized (room.getRoomLock()) {
        if (room.getStatus() == RoomStatus.FINISHED || room.getEndReason() != null || room.getPlayer(forfeitedUserId) == null) {
            log.info("[PVP] Ignoring forfeit for room {} because room is already FINISHED (endReason={})",
                    room.getRoomCode(), room.getEndReason());
            return;
        }
        terminateMatchInternal(room, "FORFEIT", forfeitedUserId);
        }
    }

    private void terminateMatchInternal(CardBlastRoom room, String reason, String explicitForfeitedUserId) {
        if (room.getStatus() != RoomStatus.IN_GAME && room.getStatus() != RoomStatus.COUNTDOWN) return;
        if (!Set.of("KO", "FORFEIT", "WORDS_EXHAUSTED").contains(reason)) return;
        if ("KO".equals(reason) && room.getHost().getHp() > 0 && (room.getGuest() == null || room.getGuest().getHp() > 0)) return;
        if ("WORDS_EXHAUSTED".equals(reason) && (room.getStatus() != RoomStatus.IN_GAME ||
                !room.getSchedule().stream().allMatch(w -> room.getHost().getResolvedSeqs().contains(w.getSeq()) &&
                        (room.getGuest() == null || room.getGuest().getResolvedSeqs().contains(w.getSeq()))) ||
                !room.getPendingAttacks().isEmpty() || !room.getActiveGarbageWords().isEmpty())) return;

        room.setStatus(RoomStatus.FINISHED);
        room.setEndReason(reason);
        room.touch();

        PlayerState host = room.getHost();
        PlayerState guest = room.getGuest();

        String winnerId = "DRAW";
        String loserId = null;
        if ("KO".equals(reason)) {
            if (host.getHp() <= 0 && guest != null && guest.getHp() <= 0) {
                winnerId = "DRAW";
            } else if (host.getHp() <= 0) {
                winnerId = guest != null ? guest.getUserId() : "DRAW";
                loserId = host.getUserId();
            } else if (guest != null && guest.getHp() <= 0) {
                winnerId = host.getUserId();
                loserId = guest.getUserId();
            } else {
                log.warn("[PVP] Reject KO termination in room {}: both players HP > 0 (host HP={}, guest HP={})",
                        room.getRoomCode(), host.getHp(), guest != null ? guest.getHp() : "N/A");
                room.setStatus(RoomStatus.IN_GAME);
                room.setEndReason(null);
                return;
            }
        } else if ("FORFEIT".equals(reason)) {
            if (explicitForfeitedUserId != null) {
                loserId = explicitForfeitedUserId;
                PlayerState forfeiter = room.getPlayer(explicitForfeitedUserId);
                if (forfeiter != null) {
                    forfeiter.setConnected(false);
                    forfeiter.setHp(0);
                }
                PlayerState opponent = room.getOpponent(explicitForfeitedUserId);
                winnerId = opponent != null ? opponent.getUserId() : "DRAW";
            } else if (host != null && !host.isConnected()) {
                winnerId = guest != null ? guest.getUserId() : "DRAW";
                loserId = host.getUserId();
                host.setHp(0);
            } else if (guest != null && !guest.isConnected()) {
                winnerId = host != null ? host.getUserId() : "DRAW";
                loserId = guest.getUserId();
                guest.setHp(0);
            }
        } else if ("WORDS_EXHAUSTED".equals(reason)) {
            if (guest == null) {
                winnerId = host.getUserId();
            } else if (host.getHp() != guest.getHp()) {
                winnerId = host.getHp() > guest.getHp() ? host.getUserId() : guest.getUserId();
                loserId = host.getHp() > guest.getHp() ? guest.getUserId() : host.getUserId();
            } else if (host.getScore() != guest.getScore()) {
                winnerId = host.getScore() > guest.getScore() ? host.getUserId() : guest.getUserId();
                loserId = host.getScore() > guest.getScore() ? guest.getUserId() : host.getUserId();
            } else {
                winnerId = "DRAW";
            }
        }

        room.setWinnerId(winnerId);

        long durationMs = (room.getMatchStartServerMs() != null)
                ? Math.max(0, System.currentTimeMillis() - room.getMatchStartServerMs())
                : 0L;

        // Elo Rating Calculation (Human vs Human >= 30s, max 5/pair/24h)
        boolean isHumanVsHuman = room.getMode() == RoomMode.HUMAN && host != null && guest != null;
        Long hostUid = parseLongSafe(host != null ? host.getUserId() : null);
        Long guestUid = parseLongSafe(guest != null ? guest.getUserId() : null);
        boolean durationOk = durationMs >= CardBlastPvPConstants.MIN_RANKED_MATCH_DURATION_MS;

        boolean sentinelRanked = sentinelAllowsRanking(room, reason, loserId);
        boolean isRanked = false;
        Integer hostRatingDelta = null;
        Integer guestRatingDelta = null;

        if (isHumanVsHuman && sentinelRanked && hostUid != null && guestUid != null && durationOk && pvpMatchRepository != null && pvpRatingRepository != null) {
            try {
                Instant last24h = Instant.now().minusSeconds(86400);
                long recentRankedCount = pvpMatchRepository.countRankedMatchesBetweenPairSince(hostUid, guestUid, last24h);
                if (recentRankedCount < CardBlastPvPConstants.MAX_RANKED_MATCHES_PER_PAIR_24H) {
                    isRanked = true;
                    PvpRating hostRating = pvpRatingRepository.findById(hostUid)
                            .orElseGet(() -> PvpRating.builder().userId(hostUid).rating(CardBlastPvPConstants.DEFAULT_ELO_RATING).wins(0).losses(0).build());
                    PvpRating guestRating = pvpRatingRepository.findById(guestUid)
                            .orElseGet(() -> PvpRating.builder().userId(guestUid).rating(CardBlastPvPConstants.DEFAULT_ELO_RATING).wins(0).losses(0).build());

                    double rA = hostRating.getRating();
                    double rB = guestRating.getRating();
                    double expectedA = 1.0 / (1.0 + Math.pow(10.0, (rB - rA) / 400.0));
                    double expectedB = 1.0 / (1.0 + Math.pow(10.0, (rA - rB) / 400.0));

                    double actualA;
                    double actualB;
                    if ("DRAW".equals(winnerId)) {
                        actualA = 0.5;
                        actualB = 0.5;
                    } else if (winnerId != null && winnerId.equals(host.getUserId())) {
                        actualA = 1.0;
                        actualB = 0.0;
                        hostRating.setWins(hostRating.getWins() + 1);
                        guestRating.setLosses(guestRating.getLosses() + 1);
                    } else {
                        actualA = 0.0;
                        actualB = 1.0;
                        hostRating.setLosses(hostRating.getLosses() + 1);
                        guestRating.setWins(guestRating.getWins() + 1);
                    }

                    hostRatingDelta = (int) Math.round(CardBlastPvPConstants.ELO_K_FACTOR * (actualA - expectedA));
                    guestRatingDelta = (int) Math.round(CardBlastPvPConstants.ELO_K_FACTOR * (actualB - expectedB));

                    hostRating.setRating(Math.max(100, hostRating.getRating() + hostRatingDelta));
                    guestRating.setRating(Math.max(100, guestRating.getRating() + guestRatingDelta));
                    hostRating.setUpdatedAt(Instant.now());
                    guestRating.setUpdatedAt(Instant.now());

                    pvpRatingRepository.save(hostRating);
                    pvpRatingRepository.save(guestRating);
                    log.info("[PVP ELO] Ranked match in room {}: Host {} delta={}, Guest {} delta={}",
                            room.getRoomCode(), hostUid, hostRatingDelta, guestUid, guestRatingDelta);
                } else {
                    log.info("[PVP ELO] Pair {} - {} reached 24h ranked match limit ({}), match recorded unranked.",
                            hostUid, guestUid, recentRankedCount);
                }
            } catch (Exception ex) {
                log.error("[PVP ELO ERROR] Room {}: {}", room.getRoomCode(), ex.getMessage(), ex);
            }
        }

        PlayerMatchStats hostStats = toStats(host, room, hostRatingDelta);
        PlayerMatchStats guestStats = guest != null ? toStats(guest, room, guestRatingDelta) : null;

        MatchEndPayload payload = MatchEndPayload.builder()
                .roomCode(room.getRoomCode())
                .winnerId(winnerId)
                .loserId(loserId)
                .reason(reason)
                .durationMs(durationMs)
                .isRanked(isRanked)
                .hostStats(hostStats)
                .guestStats(guestStats)
                .build();

        room.setFinalResult(payload);
        if (host != null) {
            sendToPlayerUserQueue(host, "/queue/pvp",
                    PvPMessage.of("MATCH_END", room.getRoomCode(), payload));
        }
        if (guest != null) {
            sendToPlayerUserQueue(guest, "/queue/pvp",
                    PvPMessage.of("MATCH_END", room.getRoomCode(), payload));
        }
        broadcastRoomState(room);
        log.info("[PVP] Match ended in room {} (winner={}, reason={}, duration={}ms, ranked={})",
                room.getRoomCode(), winnerId, reason, durationMs, isRanked);

        if (pvpMatchRepository != null) {
            persistMatchDataAsync(room, winnerId, reason, durationMs, isRanked, hostUid, guestUid);
        }
    }

    private void persistMatchDataAsync(CardBlastRoom room, String winnerId, String reason, long durationMs, boolean isRanked, Long hostUid, Long guestUid) {
        try {
            Instant startedAt = room.getMatchStartServerMs() != null
                    ? Instant.ofEpochMilli(room.getMatchStartServerMs())
                    : Instant.now().minusMillis(durationMs);
            Instant endedAt = Instant.now();
            Long winnerUid = parseLongSafe(winnerId);

            PvpMatch matchRecord = PvpMatch.builder()
                    .roomCode(room.getRoomCode())
                    .deckId(room.getDeckId())
                    .mode(room.getMode() != null ? room.getMode().name() : "HUMAN")
                    .seed(room.getSeed())
                    .hostUserId(hostUid)
                    .guestUserId(guestUid)
                    .winnerUserId(winnerUid)
                    .result("DRAW".equals(winnerId) ? "DRAW" : (winnerId != null ? "WIN" : "DRAW"))
                    .endReason(reason)
                    .startedAt(startedAt)
                    .endedAt(endedAt)
                    .durationMs(durationMs)
                    .hostScore(room.getHost() != null ? room.getHost().getScore() : 0)
                    .guestScore(room.getGuest() != null ? room.getGuest().getScore() : 0)
                    .isRanked(isRanked)
                    .build();

            PvpMatch savedMatch = pvpMatchRepository.save(matchRecord);
            Long matchId = savedMatch.getId();

            if (pvpPlayerStatsRepository != null) {
                if (room.getHost() != null && hostUid != null) {
                    savePlayerStats(matchId, hostUid, room.getHost());
                }
                if (room.getGuest() != null && guestUid != null) {
                    savePlayerStats(matchId, guestUid, room.getGuest());
                }
            }

            if (pvpMissedWordRepository != null) {
                if (room.getHost() != null && hostUid != null) {
                    saveMissedWords(matchId, hostUid, room.getHost());
                }
                if (room.getGuest() != null && guestUid != null) {
                    saveMissedWords(matchId, guestUid, room.getGuest());
                }
            }
            if (eventPublisher != null) eventPublisher.publishEvent(new com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent(matchId, room.getMode() != null ? room.getMode().name() : "HUMAN", hostUid, guestUid, winnerId, reason, durationMs, isRanked, room.getHost() != null ? room.getHost().getHits() : 0, room.getGuest() != null ? room.getGuest().getHits() : 0, room.getDeckId(), endedAt));
            log.info("[PVP PERSIST] Saved match #{} for room {}", matchId, room.getRoomCode());
        } catch (Exception ex) {
            log.error("[PVP PERSIST ERROR] Room {}: {}", room.getRoomCode(), ex.getMessage(), ex);
        }
    }

    private void savePlayerStats(Long matchId, Long userId, PlayerState p) {
        int avgReaction = p.getReactionCount() > 0 ? (int) (p.getTotalReactionTimeMs() / p.getReactionCount()) : 0;
        PvpPlayerStats stats = PvpPlayerStats.builder()
                .matchId(matchId)
                .userId(userId)
                .hits(p.getHits())
                .misses(p.getMisses())
                .bestStreak(p.getBestStreak())
                .avgReactionMs(avgReaction)
                .goldenCaptured(p.getGoldenCaptured())
                .attacksSent(p.getAttacksSent())
                .attacksReceived(p.getAttacksReceived())
                .skillsUsed(p.getSkillsUsed())
                .build();
        pvpPlayerStatsRepository.save(stats);
    }

    private void saveMissedWords(Long matchId, Long userId, PlayerState p) {
        if (p.getMissedWordIds() == null || p.getMissedWordIds().isEmpty()) return;
        List<PvpMissedWord> list = new ArrayList<>();
        Instant now = Instant.now();
        for (Long wordId : p.getMissedWordIds()) {
            list.add(PvpMissedWord.builder()
                    .userId(userId)
                    .wordId(wordId)
                    .matchId(matchId)
                    .missedAt(now)
                    .build());
        }
        pvpMissedWordRepository.saveAll(list);
    }

    private Long parseLongSafe(String s) {
        if (s == null) return null;
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private PlayerMatchStats toStats(PlayerState p, CardBlastRoom room, Integer ratingDelta) {
        if (p == null) return null;
        int total = p.getHits() + p.getMisses();
        int accuracy = total > 0 ? (int) Math.round(((double) p.getHits() / total) * 100) : 100;
        int avgReaction = p.getReactionCount() > 0 ? (int) (p.getTotalReactionTimeMs() / p.getReactionCount()) : 0;

        List<MissedWordDetail> missedDetails = new ArrayList<>();
        if (p.getMissedWordIds() != null && room.getSchedule() != null) {
            for (Long wid : p.getMissedWordIds()) {
                for (ScheduledWord sw : room.getSchedule()) {
                    if (Objects.equals(sw.getWordId(), wid)) {
                        missedDetails.add(MissedWordDetail.builder()
                                .wordId(sw.getWordId())
                                .word(sw.getWord())
                                .ipa(sw.getIpa())
                                .vietnamese(sw.getVietnamese())
                                .meanings(sw.getTargetAnswers())
                                .build());
                        break;
                    }
                }
            }
        }

        return PlayerMatchStats.builder()
                .userId(p.getUserId())
                .displayName(p.getDisplayName())
                .score(p.getScore())
                .accuracy(accuracy)
                .maxStreak(p.getBestStreak())
                .hits(p.getHits())
                .misses(p.getMisses())
                .remainingHp(p.getHp())
                .avgReactionMs(avgReaction)
                .goldenCaptured(p.getGoldenCaptured())
                .attacksSent(p.getAttacksSent())
                .attacksReceived(p.getAttacksReceived())
                .attacksDeflected(p.getAttacksDeflected())
                .skillsUsed(p.getSkillsUsed())
                .ratingDelta(ratingDelta)
                .missedWords(missedDetails)
                .build();
    }

    public List<MissedWordDetail> getMissedWordDetails(Long userId, Long matchId) {
        List<PvpMissedWord> missedList;
        if (pvpMissedWordRepository == null) {
            return Collections.emptyList();
        }
        if (userId != null && matchId != null) {
            missedList = pvpMissedWordRepository.findByUserIdAndMatchId(userId, matchId);
        } else if (matchId != null) {
            missedList = pvpMissedWordRepository.findByMatchId(matchId);
        } else if (userId != null) {
            missedList = pvpMissedWordRepository.findByUserIdOrderByMissedAtDesc(userId);
        } else {
            return Collections.emptyList();
        }

        if (missedList == null || missedList.isEmpty()) {
            return Collections.emptyList();
        }

        List<MissedWordDetail> details = new ArrayList<>();
        Set<Long> processedWordIds = new HashSet<>();

        for (PvpMissedWord mw : missedList) {
            Long wid = mw.getWordId();
            if (wid == null || !processedWordIds.add(wid)) continue;

            try {
                if (dictionaryRepository != null) {
                    var entryOpt = dictionaryRepository.findById(wid);
                    if (entryOpt.isPresent()) {
                        var d = entryOpt.get();
                        String vi = d.getGeneralTranslationVi() != null ? d.getGeneralTranslationVi()
                                : (d.getMeanings() != null && !d.getMeanings().isEmpty() ? d.getMeanings().get(0) : "");
                        details.add(MissedWordDetail.builder()
                                .wordId(d.getId())
                                .word(d.getWord())
                                .ipa(d.getIpa())
                                .vietnamese(vi)
                                .meanings(d.getMeanings())
                                .build());
                        continue;
                    }
                }
            } catch (Exception ignored) {}

            details.add(MissedWordDetail.builder()
                    .wordId(wid)
                    .word("Word #" + wid)
                    .ipa("")
                    .vietnamese("")
                    .meanings(Collections.emptyList())
                    .build());
        }

        return details;
    }

    public void handleUserDisconnect(String userId) {
        handleUserDisconnect(userId, null);
    }

    public void bindPlayerSession(String userId, String roomCode, String sessionId) {
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) return;
        synchronized (room.getRoomLock()) {
            PlayerState player = room.getPlayer(userId);
            if (player != null) player.setSessionId(sessionId);
        }
    }

    public void handleUserDisconnect(String userId, String sessionId) {
        String roomCode = userActiveRooms.get(userId);
        if (roomCode == null) return;

        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) {
            userActiveRooms.remove(userId);
            return;
        }

        synchronized (room.getRoomLock()) {
            PlayerState player = room.getPlayer(userId);
            if (player == null) return;
            // Notifications and previous sockets share the same account principal.
            // Only the socket that owns this player's room may disconnect it.
            if (sessionId != null && !sessionId.equals(player.getSessionId())) return;
            if (!player.isConnected()) return;

            player.setConnected(false);
            room.touch();

            if (room.getStatus() == RoomStatus.WAITING || room.getStatus() == RoomStatus.FINISHED) {
                player.setDisconnectDeadlineMs(System.currentTimeMillis() + CardBlastPvPConstants.WAITING_DISCONNECT_GRACE_PERIOD_MS);
                broadcastRoomState(room);
                return;
            }

            // Normal match-end guard: if either player has HP <= 0, game reached KO; do NOT trigger forfeit
            if (room.getStatus() == RoomStatus.IN_GAME && (
                    (room.getHost() != null && room.getHost().getHp() <= 0) ||
                    (room.getGuest() != null && room.getGuest().getHp() <= 0)
            )) {
                log.info("[PVP] User {} disconnected from room {} where HP is already <= 0; terminating as KO instead of forfeit", userId, roomCode);
                terminateMatch(room, "KO");
                return;
            }

            if (room.getStatus() == RoomStatus.IN_GAME || room.getStatus() == RoomStatus.COUNTDOWN) {
                player.setDisconnectDeadlineMs(System.currentTimeMillis() + CardBlastPvPConstants.DISCONNECT_GRACE_PERIOD_MS);
                log.info("[PVP] User {} disconnected during game in room {}. 15s grace period initiated.", userId, roomCode);
                broadcastLiveState(room, null);
            }
        }
    }

    public CardBlastRoom rejoinRoom(String userId, String rawRoomCode) {
        return rejoinRoom(userId, rawRoomCode, null);
    }

    public CardBlastRoom rejoinRoom(String userId, String rawRoomCode, String principalName) {
        return rejoinRoom(userId, rawRoomCode, principalName, null);
    }

    public CardBlastRoom rejoinRoom(String userId, String rawRoomCode, String principalName, String sessionId) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) {
            throw new IllegalArgumentException("Room not found: " + roomCode);
        }

        synchronized (room.getRoomLock()) {
            PlayerState player = room.getPlayer(userId);
            if (player == null) {
                throw new IllegalStateException("User " + userId + " is not a participant of room " + roomCode);
            }

            if (sessionId != null) player.setSessionId(sessionId);
            player.setConnected(true);
            player.setDisconnectDeadlineMs(null);
            if (principalName != null) {
                player.setPrincipalName(principalName);
            }
            userActiveRooms.put(userId, roomCode);
            room.touch();

            log.info("[PVP] User {} rejoined room {}", userId, roomCode);
            if (room.getStatus() == RoomStatus.FINISHED && room.getFinalResult() != null) {
                sendToPlayerUserQueue(player, "/queue/pvp", PvPMessage.of("MATCH_END", roomCode, room.getFinalResult()));
            }
            if (room.getStatus() == RoomStatus.IN_GAME || room.getStatus() == RoomStatus.COUNTDOWN) {
                broadcastLiveState(room, null);
            } else {
                broadcastRoomState(room);
            }
            return room;
        }
    }

    public void leaveRoom(String userId, String rawRoomCode) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        if (roomCode == null || roomCode.isBlank()) {
            roomCode = userActiveRooms.get(userId);
        }
        if (roomCode == null) {
            userActiveRooms.remove(userId);
            return;
        }

        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) {
            userActiveRooms.remove(userId);
            return;
        }

        synchronized (room.getRoomLock()) {
            userActiveRooms.remove(userId);

            if (room.getStatus() == RoomStatus.FINISHED) {
                // When a player leaves a FINISHED room, it is a normal post-match exit, NEVER a forfeit!
                if (room.isHost(userId)) {
                    log.info("[PVP] Host {} left finished room {}. Dissolving room.", userId, roomCode);
                    messagingTemplate.convertAndSend(
                            "/topic/pvp/" + roomCode,
                            PvPMessage.of("ROOM_DISSOLVED", roomCode, Map.of(
                                    "reason", "HOST_LEFT",
                                    "message", "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán."
                            ))
                    );
                    if (room.getGuest() != null && room.getGuest().getUserId() != null) {
                        sendToPlayerUserQueue(
                                room.getGuest(),
                                "/queue/pvp",
                                PvPMessage.of("ROOM_DISSOLVED", roomCode, Map.of(
                                        "reason", "HOST_LEFT",
                                        "message", "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán."
                                ))
                        );
                        userActiveRooms.remove(room.getGuest().getUserId());
                    }
                    activeRooms.remove(roomCode);
                    botHitSchedules.remove(roomCode);
                    clearRoomHitTracking(roomCode);
                } else if (room.isGuest(userId)) {
                    log.info("[PVP] Guest {} left finished room {}. Resetting to WAITING for host.", userId, roomCode);
                    room.setGuest(null);
                    resetRoomToWaiting(room);
                    broadcastRoomState(room);
                }
                return;
            }

            // Normal match-end guard: if either player has HP <= 0, game reached KO; do NOT trigger forfeit
            if (room.getStatus() == RoomStatus.IN_GAME && (
                    (room.getHost() != null && room.getHost().getHp() <= 0) ||
                    (room.getGuest() != null && room.getGuest().getHp() <= 0)
            )) {
                log.info("[PVP] Player {} leaving room {} where HP is already <= 0; terminating as KO instead of FORFEIT", userId, roomCode);
                terminateMatch(room, "KO");
                return;
            }

            if (room.getStatus() == RoomStatus.IN_GAME || room.getStatus() == RoomStatus.COUNTDOWN) {
                terminateMatchForfeit(room, userId);
            } else if (room.getStatus() == RoomStatus.WAITING) {
                if (room.isHost(userId)) {
                    log.info("[PVP] Host {} left room {}. Dissolving room.", userId, roomCode);
                    messagingTemplate.convertAndSend(
                            "/topic/pvp/" + roomCode,
                            PvPMessage.of("ROOM_DISSOLVED", roomCode, Map.of(
                                    "reason", "HOST_LEFT",
                                    "message", "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán."
                            ))
                    );
                    if (room.getGuest() != null && room.getGuest().getUserId() != null) {
                        sendToPlayerUserQueue(
                                room.getGuest(),
                                "/queue/pvp",
                                PvPMessage.of("ROOM_DISSOLVED", roomCode, Map.of(
                                        "reason", "HOST_LEFT",
                                        "message", "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán."
                                ))
                        );
                        userActiveRooms.remove(room.getGuest().getUserId());
                    }
                    activeRooms.remove(roomCode);
                    botHitSchedules.remove(roomCode);
                    clearRoomHitTracking(roomCode);
                } else if (room.isGuest(userId)) {
                    log.info("[PVP] Guest {} left room {}.", userId, roomCode);
                    room.setGuest(null);
                    broadcastRoomState(room);
                }
            }
        }
    }

    public void requestRematch(String userId, String rawRoomCode) {
        String roomCode = RoomCodeGenerator.sanitize(rawRoomCode);
        if (roomCode == null || roomCode.isBlank()) {
            roomCode = userActiveRooms.get(userId);
        }
        if (roomCode == null) return;
        CardBlastRoom room = activeRooms.get(roomCode);
        if (room == null) return;

        synchronized (room.getRoomLock()) {
            if (room.getStatus() != RoomStatus.FINISHED) return;

            PlayerState player = room.getPlayer(userId);
            if (player == null) return;
            player.setRematchRequested(true);

            boolean isHost = room.isHost(userId);
            PlayerState opponent = isHost ? room.getGuest() : room.getHost();

            // Block rematch if match ended due to forfeit and requester is not the host resetting the room
            if ("FORFEIT".equalsIgnoreCase(room.getEndReason()) && !isHost) {
                sendToPlayerUserQueue(
                        player,
                        "/queue/pvp",
                        PvPMessage.of("ERROR", roomCode, Map.of("message", "Đối thủ đã rời đi. Vui lòng tạo hoặc tham gia phòng mới."))
                );
                return;
            }

            // If opponent is absent or disconnected
            if (opponent == null || !opponent.isConnected()) {
                if (isHost) {
                    log.info("[PVP] Host {} requested rematch in room {} with no active guest. Resetting to WAITING for new guest.", userId, roomCode);
                    if (room.getGuest() != null) {
                        userActiveRooms.remove(room.getGuest().getUserId());
                        room.setGuest(null);
                    }
                    resetRoomToWaiting(room);
                    broadcastRoomState(room);
                    return;
                } else {
                    sendToPlayerUserQueue(
                            player,
                            "/queue/pvp",
                            PvPMessage.of("ERROR", roomCode, Map.of("message", "Đối thủ đã rời đi. Vui lòng tạo hoặc tham gia phòng mới."))
                    );
                    return;
                }
            }

            boolean hostReq = room.getHost() != null && room.getHost().isRematchRequested();
            boolean guestReq = (room.getMode() == RoomMode.BOT) || (room.getGuest() != null && room.getGuest().isRematchRequested());

            if (hostReq && guestReq) {
                resetRoomToWaiting(room);
                if (room.getMode() == RoomMode.BOT) {
                    room.getGuest().setReady(true);
                    planBotHits(room);
                }
                log.info("[PVP] Room {} reset for rematch", roomCode);
                broadcastRoomState(room);
            } else {
                broadcastRoomState(room);
            }
        }
    }

    private void resetRoomToWaiting(CardBlastRoom room) {
        clearRoomHitTracking(room.getRoomCode());
        room.setStatus(RoomStatus.WAITING);
        room.setWinnerId(null);
        room.setEndReason(null);
        room.setFinalResult(null);
        room.setMatchStartServerMs(null);
        room.setSuddenDeath(false);
        room.setNextGoldenTargetMs(CardBlastPvPConstants.FIRST_GOLDEN_WORD_MS);
        room.setActiveGoldenWord(null);
        room.setGoldenWordClaimedBy(null);
        room.getUsedGarbageWordIds().clear();
        room.getPendingAttacks().clear();
        room.getActiveGarbageWords().clear();

        if (room.getHost() != null) {
            room.getHost().resetForRematch();
            room.getHost().setHp(CardBlastPvPConstants.STARTING_HP);
            room.getHost().setScore(0);
            room.getHost().setStreak(0);
            room.getHost().setBestStreak(0);
            room.getHost().setHits(0);
            room.getHost().setMisses(0);
            room.getHost().setAttacksSent(0);
            room.getHost().setAttacksReceived(0);
            room.getHost().setGoldenCaptured(0);
            room.getHost().setSkillsUsed(0);
            room.getHost().setReady(false);
            room.getHost().setRematchRequested(false);
            room.getHost().setLastStand(false);
            room.getHost().setLastStandTriggered(false);
        }

        if (room.getGuest() != null) {
            if (!room.getGuest().isConnected()) {
                userActiveRooms.remove(room.getGuest().getUserId());
                room.setGuest(null);
            } else {
                room.getGuest().resetForRematch();
                room.getGuest().setHp(CardBlastPvPConstants.STARTING_HP);
                room.getGuest().setScore(0);
                room.getGuest().setStreak(0);
                room.getGuest().setBestStreak(0);
                room.getGuest().setHits(0);
                room.getGuest().setMisses(0);
                room.getGuest().setAttacksSent(0);
                room.getGuest().setAttacksReceived(0);
                room.getGuest().setGoldenCaptured(0);
                room.getGuest().setSkillsUsed(0);
                room.getGuest().setReady(false);
                room.getGuest().setRematchRequested(false);
                room.getGuest().setLastStand(false);
                room.getGuest().setLastStandTriggered(false);
            }
        }

        long newSeed = secureRandom.nextLong();
        room.setSeed(newSeed);
        if (room.getHost() != null) {
            List<WordSource> words = loadWordsForDeck(room.getHost().getUserId(), room.getDeckId(), room.getDirection());
            room.setSchedule(ScheduleBuilder.buildSchedule(words, newSeed, room.getDirection(), room.getSpeedLevel(), room.getHintLevel()));
        }
        room.touch();
    }

    private void leaveUserCurrentRoom(String userId) {
        String existingCode = userActiveRooms.remove(userId);
        if (existingCode != null) {
            CardBlastRoom existingRoom = activeRooms.get(existingCode);
            if (existingRoom != null) {
                leaveRoom(userId, existingCode);
            }
        }
    }

    private String generateUniqueRoomCode() {
        for (int i = 0; i < 50; i++) {
            String code = RoomCodeGenerator.generate();
            if (!activeRooms.containsKey(code)) {
                return code;
            }
        }
        return UUID.randomUUID().toString().substring(0, 6).toUpperCase();
    }

    private void planBotHits(CardBlastRoom room) {
        Map<Integer, Long> hits = new ConcurrentHashMap<>();
        BotLevel level = room.getBotLevel() != null ? room.getBotLevel() : BotLevel.NORMAL;
        double hitProb = level.getHitProbability();

        for (ScheduledWord sw : room.getSchedule()) {
            if (secureRandom.nextDouble() <= hitProb) {
                int len = Math.max(1, sw.getWord() != null ? sw.getWord().length() : 4);
                long think;
                long msPerChar;
                switch (level) {
                    case EASY:
                        think = CardBlastPvPConstants.BOT_EASY_MIN_THINK_MS +
                                secureRandom.nextLong(CardBlastPvPConstants.BOT_EASY_MAX_THINK_MS - CardBlastPvPConstants.BOT_EASY_MIN_THINK_MS + 1L);
                        msPerChar = CardBlastPvPConstants.BOT_EASY_MS_PER_CHAR;
                        break;
                    case HARD:
                        think = CardBlastPvPConstants.BOT_HARD_MIN_THINK_MS +
                                secureRandom.nextLong(CardBlastPvPConstants.BOT_HARD_MAX_THINK_MS - CardBlastPvPConstants.BOT_HARD_MIN_THINK_MS + 1L);
                        msPerChar = CardBlastPvPConstants.BOT_HARD_MS_PER_CHAR;
                        break;
                    case NORMAL:
                    default:
                        think = CardBlastPvPConstants.BOT_NORMAL_MIN_THINK_MS +
                                secureRandom.nextLong(CardBlastPvPConstants.BOT_NORMAL_MAX_THINK_MS - CardBlastPvPConstants.BOT_NORMAL_MIN_THINK_MS + 1L);
                        msPerChar = CardBlastPvPConstants.BOT_NORMAL_MS_PER_CHAR;
                        break;
                }
                long delay = think + (msPerChar * len);

                if (delay <= CardBlastPvPConstants.BOT_MAX_FALL_RATIO * sw.getFallDurationMs()) {
                    hits.put(sw.getSeq(), sw.getSpawnAtMs() + delay);
                }
            }
        }

        botHitSchedules.put(room.getRoomCode(), hits);
    }

    @Scheduled(fixedRate = CardBlastPvPConstants.TICK_INTERVAL_MS)
    public void gameLoopTick() {
        if (activeRooms.isEmpty()) return;
        long now = System.currentTimeMillis();

        for (CardBlastRoom room : activeRooms.values()) {
            try {
                processRoomTick(room, now);
            } catch (Exception ex) {
                log.error("[PVP TICK ERROR] Room {}: {}", room.getRoomCode(), ex.getMessage(), ex);
            }
        }
    }

    private void processRoomTick(CardBlastRoom room, long now) {
        synchronized (room.getRoomLock()) {
            if (room.getStatus() == RoomStatus.COUNTDOWN) {
                if (room.getMatchStartServerMs() != null && now >= room.getMatchStartServerMs()) {
                    room.setStatus(RoomStatus.IN_GAME);
                    room.setMatchStartServerMs(now);
                    room.setSuddenDeath(false);
                    broadcastLiveState(room, null);
                    broadcastRoomState(room);
                    log.info("[PVP] Room {} transitioned to IN_GAME at {}", room.getRoomCode(), now);
                }
                return;
            }

            if (room.getStatus() != RoomStatus.IN_GAME) {
                return;
            }

            if (room.getMatchStartServerMs() == null) {
                room.setMatchStartServerMs(now);
                room.setSuddenDeath(false);
            }
            long matchStart = room.getMatchStartServerMs();
            long matchNowMs = Math.max(0, now - matchStart);

            // 1. Process Bot Echo Actions
            if (room.getMode() == RoomMode.BOT && room.getGuest() != null) {
                Map<Integer, Long> botHits = botHitSchedules.get(room.getRoomCode());
                if (botHits != null) {
                    boolean isBotFogged = room.getGuest().getFogActiveUntilMs() != null && now <= room.getGuest().getFogActiveUntilMs();
                    for (Map.Entry<Integer, Long> entry : botHits.entrySet()) {
                        int seq = entry.getKey();
                        long targetTime = entry.getValue();
                        if (matchNowMs >= targetTime && !room.getGuest().getResolvedSeqs().contains(seq)) {
                            if (isBotFogged && secureRandom.nextDouble() < 0.35) {
                                applyMiss(room, room.getGuest(), seq);
                                continue;
                            }
                            executeHit(room, room.getGuest(), seq, targetTime);
                        }
                    }
                }
            }

            // 2a. Sudden Death Check (matchNowMs >= 180s)
            if (matchNowMs < CardBlastPvPConstants.SUDDEN_DEATH_ELAPSED_MS) {
                if (room.isSuddenDeath()) {
                    room.setSuddenDeath(false);
                }
            } else if (!room.isSuddenDeath()) {
                room.setSuddenDeath(true);
                messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                        PvPMessage.of("SUDDEN_DEATH", room.getRoomCode(), new SuddenDeathPayload(room.getRoomCode(), matchNowMs)));
                log.info("[PVP] Sudden Death activated in room {} at {}ms", room.getRoomCode(), matchNowMs);
            }

            // 2b. Auto-resolve Overdue Words as MISS
            for (ScheduledWord sw : room.getSchedule()) {
                if (room.getStatus() != RoomStatus.IN_GAME) {
                    return;
                }
                // Check Host
                if (room.getHost() != null && !room.getHost().getResolvedSeqs().contains(sw.getSeq())) {
                    long hostExp = sw.getSpawnAtMs() + sw.getFallDurationMs() + room.getHost().getDeadlineBonusMs();
                    if (matchNowMs > hostExp) {
                        applyMiss(room, room.getHost(), sw.getSeq());
                        if (room.getStatus() != RoomStatus.IN_GAME) return;
                    }
                }
                // Check Guest
                if (room.getGuest() != null && !room.getGuest().getResolvedSeqs().contains(sw.getSeq())) {
                    long guestExp = sw.getSpawnAtMs() + sw.getFallDurationMs() + room.getGuest().getDeadlineBonusMs();
                    if (matchNowMs > guestExp) {
                        applyMiss(room, room.getGuest(), sw.getSeq());
                        if (room.getStatus() != RoomStatus.IN_GAME) return;
                    }
                }
            }

            // 2c. Golden Word Contestation (every 25s, excluding last 10s)
            if (matchNowMs >= room.getNextGoldenTargetMs()) {
                room.setNextGoldenTargetMs(room.getNextGoldenTargetMs() + CardBlastPvPConstants.GOLDEN_WORD_INTERVAL_MS);
                long scheduleEndMs = calculateScheduleEndTimeMs(room);
                if (matchNowMs + CardBlastPvPConstants.GOLDEN_WORD_EXCLUDE_TAIL_MS < scheduleEndMs && room.getActiveGoldenWord() == null) {
                    spawnGoldenWord(room, matchNowMs);
                }
            }
            if (room.getActiveGoldenWord() != null) {
                long exp = room.getActiveGoldenWord().getSpawnAtMs() + room.getActiveGoldenWord().getFallDurationMs();
                if (matchNowMs > exp) {
                    log.info("[PVP] Golden word seq={} expired unclaimed in room {}", room.getActiveGoldenWord().getSeq(), room.getRoomCode());
                    room.setActiveGoldenWord(null);
                    room.setGoldenWordClaimedBy(null);
                }
            }

            // 2d. Process Pending Attacks (Telegraph -> Spawn Garbage at T+2000ms)
            for (PendingAttack attack : room.getPendingAttacks()) {
                if (attack.isParried()) {
                    room.getPendingAttacks().remove(attack);
                    continue;
                }
                if (now >= attack.getExecuteAtMs()) {
                    room.getPendingAttacks().remove(attack);

                    PlayerState target = room.getPlayer(attack.getToUserId());
                    if (target != null && target.getShieldActiveUntilMs() != null && now <= target.getShieldActiveUntilMs()) {
                        target.setShieldActiveUntilMs(null);
                        target.setAttacksDeflected(target.getAttacksDeflected() + 1);
                        ShieldAbsorbedPayload absorbed = ShieldAbsorbedPayload.builder()
                                .targetPlayerId(target.getUserId())
                                .attackerId(attack.getFromUserId())
                                .attackId(attack.getAttackId())
                                .build();
                        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                                PvPMessage.of("ATTACK_ABSORBED", room.getRoomCode(), absorbed));
                        log.info("[PVP] Shield absorbed pending attack {} for user {} in room {}",
                                attack.getAttackId(), target.getUserId(), room.getRoomCode());
                        continue;
                    }

                    ScheduledWord gw = attack.getScheduledWord();
                    gw.setSpawnAtMs(matchNowMs);
                    room.getActiveGarbageWords().put(gw.getSeq(), gw);
                    messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                            PvPMessage.of("SPAWN_GARBAGE", room.getRoomCode(), new SpawnGarbagePayload(attack.getAttackId(), attack.getToUserId(), gw)));
                    log.info("[PVP] Spawned garbage word seq={} for user {} in room {}", gw.getSeq(), attack.getToUserId(), room.getRoomCode());

                    // If victim is bot, schedule a bot hit
                    if (room.getMode() == RoomMode.BOT && room.getGuest() != null && room.getGuest().getUserId().equals(gw.getTargetPlayerId())) {
                        BotLevel level = room.getBotLevel() != null ? room.getBotLevel() : BotLevel.NORMAL;
                        if (secureRandom.nextDouble() <= level.getHitProbability()) {
                            int len = Math.max(1, gw.getWord() != null ? gw.getWord().length() : 3);
                            long think;
                            long msPerChar;
                            switch (level) {
                                case EASY:
                                    think = CardBlastPvPConstants.BOT_EASY_MIN_THINK_MS +
                                            secureRandom.nextLong(CardBlastPvPConstants.BOT_EASY_MAX_THINK_MS - CardBlastPvPConstants.BOT_EASY_MIN_THINK_MS + 1L);
                                    msPerChar = CardBlastPvPConstants.BOT_EASY_MS_PER_CHAR;
                                    break;
                                case HARD:
                                    think = CardBlastPvPConstants.BOT_HARD_MIN_THINK_MS +
                                            secureRandom.nextLong(CardBlastPvPConstants.BOT_HARD_MAX_THINK_MS - CardBlastPvPConstants.BOT_HARD_MIN_THINK_MS + 1L);
                                    msPerChar = CardBlastPvPConstants.BOT_HARD_MS_PER_CHAR;
                                    break;
                                case NORMAL:
                                default:
                                    think = CardBlastPvPConstants.BOT_NORMAL_MIN_THINK_MS +
                                            secureRandom.nextLong(CardBlastPvPConstants.BOT_NORMAL_MAX_THINK_MS - CardBlastPvPConstants.BOT_NORMAL_MIN_THINK_MS + 1L);
                                    msPerChar = CardBlastPvPConstants.BOT_NORMAL_MS_PER_CHAR;
                                    break;
                            }
                            long delay = think + (msPerChar * len);
                            if (delay <= CardBlastPvPConstants.BOT_MAX_FALL_RATIO * gw.getFallDurationMs()) {
                                Map<Integer, Long> botHits = botHitSchedules.computeIfAbsent(room.getRoomCode(), k -> new ConcurrentHashMap<>());
                                botHits.put(gw.getSeq(), matchNowMs + delay);
                            }
                        }
                    }
                }
            }

            // 2e. Expire Overdue Garbage Words
            for (ScheduledWord gw : new ArrayList<>(room.getActiveGarbageWords().values())) {
                long exp = gw.getSpawnAtMs() + gw.getFallDurationMs();
                if (matchNowMs > exp) {
                    PlayerState target = room.getPlayer(gw.getTargetPlayerId());
                    if (target != null && !target.getResolvedSeqs().contains(gw.getSeq())) {
                        if (target.getShieldActiveUntilMs() != null && now <= target.getShieldActiveUntilMs()) {
                            target.setShieldActiveUntilMs(null);
                            target.setAttacksDeflected(target.getAttacksDeflected() + 1);
                            ShieldAbsorbedPayload absorbed = ShieldAbsorbedPayload.builder()
                                    .targetPlayerId(target.getUserId())
                                    .attackerId(null)
                                    .attackId("garbage-" + gw.getSeq())
                                    .build();
                            messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                                    PvPMessage.of("ATTACK_ABSORBED", room.getRoomCode(), absorbed));
                            log.info("[PVP] Shield absorbed expiring garbage word seq={} for user {} in room {}",
                                    gw.getSeq(), target.getUserId(), room.getRoomCode());
                        } else {
                            applyMiss(room, target, gw.getSeq());
                            if (room.getStatus() != RoomStatus.IN_GAME) return;
                        }
                    }
                    room.getActiveGarbageWords().remove(gw.getSeq());
                }
            }

            // 3. Check Disconnect Grace Deadlines
            if (room.getHost() != null && !room.getHost().isConnected() && room.getHost().getDisconnectDeadlineMs() != null) {
                if (now >= room.getHost().getDisconnectDeadlineMs()) {
                    log.info("[PVP] Disconnect deadline expired for host in room {}", room.getRoomCode());
                    terminateMatchForfeit(room, room.getHost().getUserId());
                    return;
                }
            }
            if (room.getGuest() != null && !room.getGuest().isConnected() && room.getGuest().getDisconnectDeadlineMs() != null) {
                if (now >= room.getGuest().getDisconnectDeadlineMs()) {
                    log.info("[PVP] Disconnect deadline expired for guest in room {}", room.getRoomCode());
                    terminateMatchForfeit(room, room.getGuest().getUserId());
                    return;
                }
            }

            // 3b. Mana Passive Regeneration (+2.0 mana/sec -> +1 mana every 500ms)
            if (matchNowMs % 500 < CardBlastPvPConstants.TICK_INTERVAL_MS) {
                if (room.getHost() != null) {
                    room.getHost().setMana(Math.min(CardBlastPvPConstants.MAX_MANA, room.getHost().getMana() + 1));
                }
                if (room.getGuest() != null) {
                    room.getGuest().setMana(Math.min(CardBlastPvPConstants.MAX_MANA, room.getGuest().getMana() + 1));
                }
            }

            // 4. Periodic Live State Broadcast (every 200ms)
            if (matchNowMs % 200 < CardBlastPvPConstants.TICK_INTERVAL_MS) {
                broadcastLiveState(room, null);
            }
        }
    }

    @Scheduled(fixedRate = 60_000)
    public void cleanupStaleRooms() {
        if (activeRooms.isEmpty()) return;
        long now = System.currentTimeMillis();
        for (CardBlastRoom room : activeRooms.values()) {
            synchronized (room.getRoomLock()) {
                if (activeRooms.get(room.getRoomCode()) != room) continue;
                boolean purge = false;
                if (room.getStatus() == RoomStatus.WAITING) {
                    PlayerState host = room.getHost(), guest = room.getGuest();
                    if (host != null && !host.isConnected() && host.getDisconnectDeadlineMs() != null && now >= host.getDisconnectDeadlineMs()) {
                        purge = true;
                    } else if (guest != null && !guest.isConnected() && guest.getDisconnectDeadlineMs() != null && now >= guest.getDisconnectDeadlineMs()) {
                        userActiveRooms.remove(guest.getUserId(), room.getRoomCode());
                        room.setGuest(null);
                        broadcastRoomState(room);
                    } else if (now - room.getLastActivityAt() > CardBlastPvPConstants.WAITING_IDLE_PURGE_MS) {
                        purge = true;
                    }
                } else if (room.getStatus() == RoomStatus.FINISHED) {
                    purge = now - room.getLastActivityAt() > CardBlastPvPConstants.FINISHED_PURGE_MS;
                }
                // Active rooms are finalized by the game tick, never silently purged.
                if (purge) {
                    PvPMessage notice = PvPMessage.of("ROOM_DISSOLVED", room.getRoomCode(), Map.of(
                            "reason", "ROOM_EXPIRED", "message", "Phòng đã hết hạn. Vui lòng tạo hoặc tham gia phòng mới."));
                    messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(), notice);
                    sendToPlayerUserQueue(room.getHost(), "/queue/pvp", notice);
                    sendToPlayerUserQueue(room.getGuest(), "/queue/pvp", notice);
                    if (activeRooms.remove(room.getRoomCode(), room)) {
                        botHitSchedules.remove(room.getRoomCode());
                        clearRoomHitTracking(room.getRoomCode());
                        if (room.getHost() != null) userActiveRooms.remove(room.getHost().getUserId(), room.getRoomCode());
                        if (room.getGuest() != null) userActiveRooms.remove(room.getGuest().getUserId(), room.getRoomCode());
                    }
                }
            }
        }
    }

    public void broadcastRoomState(CardBlastRoom room) {
        RoomStatePayload payload = RoomStatePayload.builder()
                .roomCode(room.getRoomCode())
                .deckId(room.getDeckId())
                .deckTitle(room.getDeckTitle())
                .direction(room.getDirection())
                .mode(room.getMode())
                .botLevel(room.getBotLevel())
                .status(room.getStatus())
                .host(room.getHost())
                .guest(room.getGuest())
                .matchStartServerMs(room.getMatchStartServerMs())
                .winnerId(room.getWinnerId())
                .endReason(room.getEndReason())
                .speedLevel(room.getSpeedLevel())
                .hintLevel(room.getHintLevel())
                .suddenDeath(room.isSuddenDeath())
                .build();

        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                PvPMessage.of("ROOM_STATE", room.getRoomCode(), payload));
    }

    public void broadcastLiveState(CardBlastRoom room, LastHitInfo lastHit) {
        long matchStart = room.getMatchStartServerMs() != null ? room.getMatchStartServerMs() : System.currentTimeMillis();
        long matchNowMs = Math.max(0, System.currentTimeMillis() - matchStart);

        LiveStatePayload payload = LiveStatePayload.builder()
                .roomCode(room.getRoomCode())
                .host(room.getHost())
                .guest(room.getGuest())
                .lastHit(lastHit)
                .matchNowMs(matchNowMs)
                .suddenDeath(room.isSuddenDeath())
                .build();

        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                PvPMessage.of("STATE", room.getRoomCode(), payload));
    }

    private List<WordSource> loadWordsForDeck(String userId, Long deckId, String direction) {
        return loadWordsForDeck(userId, deckId, null, direction);
    }

    private synchronized List<WordSource> loadWordsForDeck(String userId, Long deckId, String deckSlug, String direction) {
        if (deckId == null && deckSlug != null && !deckSlug.isBlank() && !"personal".equals(deckSlug)) {
            deckId = vocabDeckRepository.findBySlug(deckSlug)
                    .orElseThrow(() -> new IllegalArgumentException("Bộ từ không còn tồn tại. Hãy chọn lại bộ từ.")).getId();
        }
        String poolKey = deckId != null ? "deck:" + deckId : "personal:" + userId;
        long now = System.currentTimeMillis();
        VocabularySnapshot snapshot = vocabularySnapshots.get(poolKey);
        if (snapshot != null && snapshot.expiresAtMs() > now) {
            log.info("[PVP TIMING] vocabularyCacheHit=true wordCount={}", snapshot.words().size());
            return snapshot.words();
        }
        vocabularySnapshots.entrySet().removeIf(entry -> entry.getValue().expiresAtMs() <= now);
        long started = System.nanoTime();
        long gcBefore = gcCollectionTimeMs();
        // One lightweight query, including translations. Never hydrate eager examples
        // for every entry in a 3,000-word deck merely to build a 60-word game.
        var rows = deckId != null ? flashcardRepository.findPvPWordsByDeckId(deckId)
                : flashcardRepository.findPvPPersonalWords(Long.valueOf(userId));
        Map<Long, WordSource> pool = new LinkedHashMap<>();
        for (var row : rows) {
            WordSource word = pool.computeIfAbsent(row.getId(), id ->
                    new WordSource(id, row.getWord(), row.getIpa(), row.getVietnamese(), new ArrayList<>()));
            if (row.getMeaning() != null && !word.allMeanings().contains(row.getMeaning())) {
                word.allMeanings().add(row.getMeaning());
            }
        }
        List<WordSource> words = pool.values().stream().map(word -> new WordSource(
                word.wordId(), word.word(), word.ipa(), word.vietnamese() != null ? word.vietnamese()
                : (word.allMeanings().isEmpty() ? "" : word.allMeanings().get(0)), List.copyOf(word.allMeanings()))).toList();
        log.info("[PVP TIMING] vocabularyMs={} wordCount={} gcCollectionMs={}",
                (System.nanoTime() - started) / 1_000_000.0, words.size(), gcCollectionTimeMs() - gcBefore);
        if (words.isEmpty()) {
            throw new IllegalArgumentException("Bộ từ này chưa có từ để chơi. Hãy chọn một bộ từ khác.");
        }
        if (vocabularySnapshots.size() >= MAX_VOCABULARY_SNAPSHOTS) {
            vocabularySnapshots.remove(vocabularySnapshots.keySet().iterator().next());
        }
        vocabularySnapshots.put(poolKey, new VocabularySnapshot(System.currentTimeMillis() + VOCABULARY_SNAPSHOT_TTL_MS, words));
        return words;
    }

    private static long gcCollectionTimeMs() {
        return java.lang.management.ManagementFactory.getGarbageCollectorMXBeans().stream()
                .mapToLong(bean -> Math.max(0, bean.getCollectionTime())).sum();
    }

    // ==========================================
    // PHASE 2 COMBAT HELPER METHODS
    // ==========================================

    public void triggerAttack(CardBlastRoom room, PlayerState attacker) {
        if (room == null || attacker == null) return;
        PlayerState victim = room.getOpponent(attacker.getUserId());
        if (victim == null) return;

        // Check Garbage Cap (3 normal, 1 in Last Stand)
        int cap = victim.isLastStand()
                ? CardBlastPvPConstants.LAST_STAND_GARBAGE_CAP
                : CardBlastPvPConstants.MAX_PENDING_AND_ACTIVE_GARBAGE;

        long pendingCount = room.getPendingAttacks().stream()
                .filter(a -> a.getToUserId().equals(victim.getUserId()) && !a.isParried())
                .count();
        long activeCount = room.getActiveGarbageWords().values().stream()
                .filter(w -> victim.getUserId().equals(w.getTargetPlayerId()))
                .count();

        if (pendingCount + activeCount >= cap) {
            log.info("[PVP] Attack dropped for victim {} in room {}: garbage cap reached ({}/{})",
                    victim.getUserId(), room.getRoomCode(), pendingCount + activeCount, cap);
            return;
        }

        ScheduledWord template = selectGarbageWord(room, victim);
        if (template == null) return;

        int seq = room.generateNextSeq();
        int lane = secureRandom.nextInt(CardBlastPvPConstants.NUM_LANES);
        ScheduleBuilder.SpeedConfig speedConfig = ScheduleBuilder.getSpeedConfig(room.getSpeedLevel());
        double progress = Math.min(1.0, (double) victim.getResolvedSeqs().size() / 50.0);
        long baseFall = Math.round(speedConfig.initialFallMs() - progress * (speedConfig.initialFallMs() - speedConfig.minFallMs()));
        double speedMult = victim.isLastStand()
                ? CardBlastPvPConstants.LAST_STAND_GARBAGE_SPEED_MULTIPLIER
                : CardBlastPvPConstants.GARBAGE_SPEED_MULTIPLIER;
        long fallDurationMs = Math.round(baseFall * speedMult);

        ScheduledWord garbageWord = ScheduledWord.builder()
                .seq(seq)
                .wordId(template.getWordId())
                .word(template.getWord())
                .ipa(template.getIpa())
                .vietnamese(template.getVietnamese())
                .targetAnswers(new ArrayList<>(template.getTargetAnswers()))
                .lane(lane)
                .spawnAtMs(0L)
                .fallDurationMs(fallDurationMs)
                .isGarbage(true)
                .isGolden(false)
                .targetPlayerId(victim.getUserId())
                .build();

        attacker.setAttacksSent(attacker.getAttacksSent() + 1);
        victim.setAttacksReceived(victim.getAttacksReceived() + 1);

        long now = System.currentTimeMillis();
        // Check Shield
        if (victim.getShieldActiveUntilMs() != null && now <= victim.getShieldActiveUntilMs()) {
            victim.setShieldActiveUntilMs(null);
            victim.setAttacksDeflected(victim.getAttacksDeflected() + 1);
            ShieldAbsorbedPayload absorbed = ShieldAbsorbedPayload.builder()
                    .targetPlayerId(victim.getUserId())
                    .attackerId(attacker.getUserId())
                    .build();
            messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                    PvPMessage.of("ATTACK_ABSORBED", room.getRoomCode(), absorbed));
            log.info("[PVP] Attack from {} absorbed by shield of {} in room {}",
                    attacker.getUserId(), victim.getUserId(), room.getRoomCode());
            return;
        }

        String attackId = UUID.randomUUID().toString();
        PendingAttack attack = PendingAttack.builder()
                .attackId(attackId)
                .fromUserId(attacker.getUserId())
                .fromName(attacker.getDisplayName())
                .toUserId(victim.getUserId())
                .createdAtMs(now)
                .telegraphMs(CardBlastPvPConstants.TELEGRAPH_DURATION_MS)
                .executeAtMs(now + CardBlastPvPConstants.TELEGRAPH_DURATION_MS)
                .scheduledWord(garbageWord)
                .parried(false)
                .build();

        room.getPendingAttacks().add(attack);

        IncomingAttackPayload incomingPayload = IncomingAttackPayload.builder()
                .attackId(attackId)
                .fromUserId(attacker.getUserId())
                .fromName(attacker.getDisplayName())
                .targetPlayerId(victim.getUserId())
                .targetUserId(victim.getUserId())
                .telegraphMs(CardBlastPvPConstants.TELEGRAPH_DURATION_MS)
                .build();

        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                PvPMessage.of("INCOMING_ATTACK", room.getRoomCode(), incomingPayload));
        log.info("[PVP] Attack {} triggered by {} against {} in room {}",
                attackId, attacker.getUserId(), victim.getUserId(), room.getRoomCode());
    }

    public ScheduledWord selectGarbageWord(CardBlastRoom room, PlayerState victim) {
        if (room.getSchedule() == null || room.getSchedule().isEmpty()) {
            return null;
        }

        // a) Words missed by the victim earlier in this match and not yet re-cleared
        if (victim.getMissedWordIds() != null && !victim.getMissedWordIds().isEmpty()) {
            for (Long missedId : victim.getMissedWordIds()) {
                if (!room.getUsedGarbageWordIds().contains(missedId)) {
                    for (ScheduledWord sw : room.getSchedule()) {
                        if (Objects.equals(sw.getWordId(), missedId)) {
                            room.getUsedGarbageWordIds().add(missedId);
                            return sw;
                        }
                    }
                }
            }
        }

        // b) Words from victim's weak words queue in SM-2 (read-only query)
        try {
            Long uid = Long.parseLong(victim.getUserId());
            var dueCards = flashcardRepository.findDueFlashcards(uid, PageRequest.of(0, 30));
            if (dueCards != null && dueCards.hasContent()) {
                for (var card : dueCards.getContent()) {
                    if (card.getDictionaryEntry() != null) {
                        Long entryId = card.getDictionaryEntry().getId();
                        String cardWord = card.getDictionaryEntry().getWord();
                        for (ScheduledWord sw : room.getSchedule()) {
                            if ((Objects.equals(sw.getWordId(), entryId) || (sw.getWord() != null && sw.getWord().equalsIgnoreCase(cardWord)))
                                    && !room.getUsedGarbageWordIds().contains(sw.getWordId())) {
                                room.getUsedGarbageWordIds().add(sw.getWordId());
                                return sw;
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
            // Non-numeric userId or query failed
        }

        // c) Fallback: Longest words in the deck
        List<ScheduledWord> sortedByLength = new ArrayList<>(room.getSchedule());
        sortedByLength.sort((w1, w2) -> {
            int len1 = w1.getWord() != null ? w1.getWord().length() : 0;
            int len2 = w2.getWord() != null ? w2.getWord().length() : 0;
            return Integer.compare(len2, len1);
        });

        for (ScheduledWord sw : sortedByLength) {
            if (!room.getUsedGarbageWordIds().contains(sw.getWordId())) {
                room.getUsedGarbageWordIds().add(sw.getWordId());
                return sw;
            }
        }

        return sortedByLength.get(0);
    }

    public void checkAndExecuteParry(CardBlastRoom room, PlayerState parrier) {
        if (room == null || parrier == null) return;
        for (PendingAttack attack : room.getPendingAttacks()) {
            if (attack.getToUserId().equals(parrier.getUserId()) && !attack.isParried()) {
                attack.setParried(true);
                parrier.setAttacksDeflected(parrier.getAttacksDeflected() + 1);
                AttackParriedPayload payload = AttackParriedPayload.builder()
                        .attackId(attack.getAttackId())
                        .parriedBy(parrier.getUserId())
                        .parriedByName(parrier.getDisplayName())
                        .targetPlayerId(parrier.getUserId())
                        .build();

                messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                        PvPMessage.of("ATTACK_PARRIED", room.getRoomCode(), payload));
                log.info("[PVP] Attack {} parried by {} in room {}", attack.getAttackId(), parrier.getUserId(), room.getRoomCode());
            }
        }
    }

    public void spawnGoldenWord(CardBlastRoom room, long matchNowMs) {
        if (room == null || room.getSchedule() == null || room.getSchedule().isEmpty()) return;

        int seq = room.generateNextSeq();
        int pickIdx = secureRandom.nextInt(room.getSchedule().size());
        ScheduledWord template = room.getSchedule().get(pickIdx);
        int lane = secureRandom.nextInt(CardBlastPvPConstants.NUM_LANES);

        ScheduleBuilder.SpeedConfig speedConfig = ScheduleBuilder.getSpeedConfig(room.getSpeedLevel());
        long baseFall = speedConfig.initialFallMs();
        long fallDurationMs = Math.round(baseFall * CardBlastPvPConstants.GOLDEN_WORD_SPEED_MULTIPLIER);

        ScheduledWord goldenWord = ScheduledWord.builder()
                .seq(seq)
                .wordId(template.getWordId())
                .word(template.getWord())
                .ipa(template.getIpa())
                .vietnamese(template.getVietnamese())
                .targetAnswers(new ArrayList<>(template.getTargetAnswers()))
                .lane(lane)
                .spawnAtMs(matchNowMs)
                .fallDurationMs(fallDurationMs)
                .isGarbage(false)
                .isGolden(true)
                .build();

        room.setActiveGoldenWord(goldenWord);
        room.setGoldenWordClaimedBy(null);

        messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                PvPMessage.of("SPAWN_GOLDEN_WORD", room.getRoomCode(), new GoldenWordPayload(goldenWord)));
        log.info("[PVP] Spawned golden word seq={} ('{}') in room {}", seq, goldenWord.getWord(), room.getRoomCode());

        // If in bot mode, schedule bot hit attempt for golden word (Task 2)
        if (room.getMode() == RoomMode.BOT && room.getGuest() != null) {
            BotLevel level = room.getBotLevel() != null ? room.getBotLevel() : BotLevel.NORMAL;
            boolean shouldAttempt = true;
            long delay;
            if (level == BotLevel.EASY) {
                // EASY: 50% probability of MISSING it entirely!
                if (secureRandom.nextDouble() > CardBlastPvPConstants.BOT_GOLDEN_EASY_HIT_PROBABILITY) {
                    shouldAttempt = false;
                    delay = 0L;
                } else {
                    delay = CardBlastPvPConstants.BOT_GOLDEN_EASY_MIN_DELAY_MS +
                            secureRandom.nextLong(CardBlastPvPConstants.BOT_GOLDEN_EASY_MAX_DELAY_MS - CardBlastPvPConstants.BOT_GOLDEN_EASY_MIN_DELAY_MS + 1L);
                }
            } else if (level == BotLevel.HARD) {
                delay = CardBlastPvPConstants.BOT_GOLDEN_HARD_MIN_DELAY_MS +
                        secureRandom.nextLong(CardBlastPvPConstants.BOT_GOLDEN_HARD_MAX_DELAY_MS - CardBlastPvPConstants.BOT_GOLDEN_HARD_MIN_DELAY_MS + 1L);
            } else { // NORMAL
                delay = CardBlastPvPConstants.BOT_GOLDEN_NORMAL_MIN_DELAY_MS +
                        secureRandom.nextLong(CardBlastPvPConstants.BOT_GOLDEN_NORMAL_MAX_DELAY_MS - CardBlastPvPConstants.BOT_GOLDEN_NORMAL_MIN_DELAY_MS + 1L);
            }

            if (shouldAttempt && delay <= CardBlastPvPConstants.BOT_MAX_FALL_RATIO * goldenWord.getFallDurationMs()) {
                Map<Integer, Long> botHits = botHitSchedules.computeIfAbsent(room.getRoomCode(), k -> new ConcurrentHashMap<>());
                botHits.put(seq, matchNowMs + delay);
            }
        }
    }

    public long calculateScheduleEndTimeMs(CardBlastRoom room) {
        if (room.getSchedule() == null || room.getSchedule().isEmpty()) {
            return 0L;
        }
        ScheduledWord last = room.getSchedule().get(room.getSchedule().size() - 1);
        return last.getSpawnAtMs() + last.getFallDurationMs();
    }

    public void handleReaction(String userId, String rawRoomCode, String reactionId) {
        String code = RoomCodeGenerator.sanitize(rawRoomCode);
        CardBlastRoom room = activeRooms.get(code);
        if (room == null) return;

        if (reactionId == null || !CardBlastPvPConstants.REACTION_WHITELIST.contains(reactionId.trim().toUpperCase())) {
            return;
        }
        reactionId = reactionId.trim().toUpperCase();

        synchronized (room.getRoomLock()) {
            PlayerState player = room.getPlayer(userId);
            if (player == null) return;

            long now = System.currentTimeMillis();
            if ((now - player.getLastReactionTimeMs()) < CardBlastPvPConstants.REACTION_RATE_LIMIT_MS) {
                return;
            }

            player.setLastReactionTimeMs(now);
            ReactionPayload payload = ReactionPayload.builder()
                    .playerId(userId)
                    .reactionId(reactionId)
                    .build();

            messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                    PvPMessage.of("REACTION", room.getRoomCode(), payload));

            // Bot reaction response with realistic 1200ms delay to prevent overwriting user reaction
            if (room.getMode() == RoomMode.BOT && room.getGuest() != null && userId.equals(room.getHost().getUserId())) {
                scheduleBotReactionDelayed(room, reactionId);
            }
        }
    }

    private void scheduleBotReactionDelayed(CardBlastRoom room, String userReactionId) {
        long matchSeed = room.getSeed();
        if (room.getGuest() == null) return;
        CompletableFuture.runAsync(() -> {
            synchronized (room.getRoomLock()) {
                if (activeRooms.get(room.getRoomCode()) != room || room.getSeed() != matchSeed) return;
                if (room.getStatus() != RoomStatus.IN_GAME && room.getStatus() != RoomStatus.WAITING) return;
                PlayerState bot = room.getGuest();
                if (bot == null) return;

                long now = System.currentTimeMillis();
                bot.setLastReactionTimeMs(now);

                String chosen;
                switch (userReactionId) {
                    case "FIRE":
                        chosen = secureRandom.nextBoolean() ? "FIRE" : "NICE";
                        break;
                    case "GG":
                        chosen = "GG";
                        break;
                    case "OOPS":
                        chosen = "NICE"; // encouraging response
                        break;
                    case "NICE":
                    default:
                        chosen = secureRandom.nextBoolean() ? "NICE" : "FIRE";
                        break;
                }

                ReactionPayload payload = ReactionPayload.builder()
                        .playerId(bot.getUserId())
                        .reactionId(chosen)
                        .build();
                messagingTemplate.convertAndSend("/topic/pvp/" + room.getRoomCode(),
                        PvPMessage.of("REACTION", room.getRoomCode(), payload));
                log.info("[PVP BOT] Bot responded with reaction {} after user reaction {} in room {}",
                        chosen, userReactionId, room.getRoomCode());
            }
        }, CompletableFuture.delayedExecutor(1200, TimeUnit.MILLISECONDS));
    }
}
