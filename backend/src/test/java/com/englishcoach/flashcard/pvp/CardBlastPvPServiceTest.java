package com.englishcoach.flashcard.pvp;

import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.CreateRoomRequest;
import com.englishcoach.flashcard.pvp.model.*;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.messaging.simp.SimpMessagingTemplate;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import com.englishcoach.flashcard.entity.VocabDeck;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import static org.mockito.Mockito.doNothing;

class CardBlastPvPServiceTest {

    @Test void freshRoomsReuseSelectedVocabularyWithoutSharingPersonalPools() {
        var request = CreateRoomRequest.builder().deckId(42L).mode(RoomMode.HUMAN).build();
        var first = pvpService.createRoom("1", "Host", null, request);
        assertEquals(first.getRoomCode(), pvpService.getActiveRoomCodeForUser("1"));
        assertNull(pvpService.getActiveRoomCodeForUser("other-owner"));
        pvpService.leaveRoom("1", first.getRoomCode());
        var second = pvpService.createRoom("1", "Host", null, request);
        assertNotEquals(first.getRoomCode(), second.getRoomCode());
        Mockito.verify(flashcardRepository, Mockito.times(1)).findPvPWordsByDeckId(42L);
        pvpService.leaveRoom("1", second.getRoomCode());
        pvpService.createRoom("1", "Host", null, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build());
        pvpService.createRoom("2", "Guest", null, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build());
        Mockito.verify(flashcardRepository).findPvPPersonalWords(1L);
        Mockito.verify(flashcardRepository).findPvPPersonalWords(2L);
    }

    @Test void selectedEmptyDeckCannotSubstitutePersonalOrGlobalWords() {
        Mockito.when(flashcardRepository.findPvPWordsByDeckId(99L)).thenReturn(List.of());
        assertThrows(IllegalArgumentException.class, () -> pvpService.createRoom("1", "Host", null,
                CreateRoomRequest.builder().deckId(99L).mode(RoomMode.HUMAN).build()));
        Mockito.verify(flashcardRepository, Mockito.never()).findByUserId(Mockito.anyLong(), Mockito.any(org.springframework.data.domain.Pageable.class));
        Mockito.verify(dictionaryRepository, Mockito.never()).findAll(Mockito.any(org.springframework.data.domain.Pageable.class));
        assertTrue(pvpService.getActiveRooms().isEmpty());
    }

    @Test void selectedDeckScheduleUsesOnlyItsMembership() {
        var room = pvpService.createRoom("1", "Host", null,
                CreateRoomRequest.builder().deckId(42L).mode(RoomMode.HUMAN).build());
        assertTrue(room.getSchedule().stream().allMatch(word -> word.getWordId() >= 101L && word.getWordId() <= 112L));
        Mockito.verify(flashcardRepository).findPvPWordsByDeckId(42L);
        Mockito.verifyNoInteractions(dictionaryRepository);
        Mockito.verify(flashcardRepository, Mockito.never()).findByUserId(Mockito.anyLong(), Mockito.any(org.springframework.data.domain.Pageable.class));
    }

    private CardBlastRoom duel() {
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build());
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        return room;
    }

    @Test void waitingDisconnectRetainsMembershipUntilGraceAndReconnectCancelsExpiry() {
        CardBlastRoom room = duel();
        pvpService.handleUserDisconnect("1");
        assertSame(room, pvpService.getRoom(room.getRoomCode()));
        assertNotNull(room.getHost().getDisconnectDeadlineMs());
        pvpService.rejoinRoom("1", room.getRoomCode());
        pvpService.cleanupStaleRooms();
        assertTrue(room.getHost().isConnected());
        assertNull(room.getHost().getDisconnectDeadlineMs());
        assertSame(room, pvpService.getRoom(room.getRoomCode()));
    }

    @Test void unrelatedAndOldSocketDisconnectCannotEjectReconnectedPlayer() {
        CardBlastRoom room = duel();
        pvpService.bindPlayerSession("1", room.getRoomCode(), "new-game-socket");
        pvpService.handleUserDisconnect("1", "notification-socket");
        pvpService.handleUserDisconnect("1", "old-game-socket");
        assertTrue(room.getHost().isConnected());
        assertNull(room.getHost().getDisconnectDeadlineMs());
        pvpService.handleUserDisconnect("1", "new-game-socket");
        assertFalse(room.getHost().isConnected());
    }

    @Test void staleWaitingCleanupCannotPurgeActiveMatch() {
        CardBlastRoom room = duel();
        room.setStatus(RoomStatus.IN_GAME);
        room.setLastActivityAt(System.currentTimeMillis() - 900000);
        pvpService.cleanupStaleRooms();
        assertSame(room, pvpService.getRoom(room.getRoomCode()));
        assertEquals(RoomStatus.IN_GAME, room.getStatus());
    }

    @Test void garbageResolutionCountCannotFinishUnresolvedBaseSchedule() {
        CardBlastRoom room = duel();
        room.setStatus(RoomStatus.IN_GAME);
        for (int i = 0; i < room.getSchedule().size(); i++) {
            room.getHost().getResolvedSeqs().add(10000 + i);
            room.getGuest().getResolvedSeqs().add(10000 + i);
        }
        pvpService.handleClientGameOver("1", room.getRoomCode(), "WORDS_EXHAUSTED");
        pvpService.terminateMatch(room, "WORDS_EXHAUSTED");
        assertEquals(RoomStatus.IN_GAME, room.getStatus());
        assertEquals(100, room.getHost().getHp());
    }

    @Test void expiredDisconnectProducesRetainedAuthoritativeResultExactlyOnce() throws Exception {
        CardBlastRoom room = duel();
        room.setStatus(RoomStatus.IN_GAME);
        pvpService.handleUserDisconnect("1");
        room.getHost().setDisconnectDeadlineMs(System.currentTimeMillis() - 1000);
        pvpService.gameLoopTick();
        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("2", room.getWinnerId());
        assertNotNull(room.getFinalResult());
        var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var a = pool.submit(() -> pvpService.terminateMatchForfeit(room, "1"));
            var b = pool.submit(() -> pvpService.terminateMatch(room, "KO"));
            a.get(3, java.util.concurrent.TimeUnit.SECONDS);
            b.get(3, java.util.concurrent.TimeUnit.SECONDS);
        } finally { pool.shutdownNow(); }
        Mockito.verify(messagingTemplate, Mockito.times(2)).convertAndSendToUser(anyString(), Mockito.eq("/queue/pvp"),
                Mockito.argThat((Object p) -> p instanceof com.englishcoach.flashcard.pvp.dto.PvPMessage m && "MATCH_END".equals(m.getType())));
        pvpService.rejoinRoom("1", room.getRoomCode());
        assertEquals("FORFEIT", room.getFinalResult().getReason());
    }

    @Test void connectedPlayerRematchCannotInheritOldDisconnectDeadline() {
        CardBlastRoom room = duel();
        room.setStatus(RoomStatus.IN_GAME);
        pvpService.handleUserDisconnect("1");
        pvpService.rejoinRoom("1", room.getRoomCode());
        room.getGuest().setHp(0);
        pvpService.terminateMatch(room, "KO");
        pvpService.requestRematch("1", room.getRoomCode());
        pvpService.requestRematch("2", room.getRoomCode());
        assertEquals(RoomStatus.WAITING, room.getStatus());
        assertNull(room.getHost().getDisconnectDeadlineMs());
        assertNull(room.getFinalResult());
    }

    private SimpMessagingTemplate messagingTemplate;
    private FlashcardRepository flashcardRepository;
    private DictionaryRepository dictionaryRepository;
    private VocabDeckRepository vocabDeckRepository;
    private CardBlastPvPService pvpService;

    @BeforeEach
    void setUp() {
        messagingTemplate = Mockito.mock(SimpMessagingTemplate.class);
        flashcardRepository = Mockito.mock(FlashcardRepository.class);
        dictionaryRepository = Mockito.mock(DictionaryRepository.class);
        vocabDeckRepository = Mockito.mock(VocabDeckRepository.class);

        doNothing().when(messagingTemplate).convertAndSend(anyString(), any(Object.class));


        var entries = new java.util.ArrayList<com.englishcoach.dictionary.entity.DictionaryEntry>();
        var cards = new java.util.ArrayList<com.englishcoach.flashcard.entity.Flashcard>();
        for(int i=0;i<12;i++) {
            var entry = new com.englishcoach.dictionary.entity.DictionaryEntry();
            entry.setId(101L+i); entry.setWord("word"+i); entry.setGeneralTranslationVi("nghĩa"+i); entry.setMeanings(java.util.List.of("nghĩa"+i));
            var card = new com.englishcoach.flashcard.entity.Flashcard(); card.setDictionaryEntry(entry);
            entries.add(entry);cards.add(card);
        }
        Mockito.when(flashcardRepository.findPvPPersonalWords(Mockito.anyLong())).thenReturn(PvPWordFixtures.rows(entries));
        Mockito.when(flashcardRepository.findPvPWordsByDeckId(Mockito.anyLong())).thenReturn(PvPWordFixtures.rows(entries));

        pvpService = new CardBlastPvPService(messagingTemplate, flashcardRepository, dictionaryRepository, vocabDeckRepository);
    }

    @Test
    @DisplayName("Should create human PvP room and enforce 1 active room per user")
    void shouldCreateRoomAndEnforceOneRoomPerUser() {
        CreateRoomRequest req = CreateRoomRequest.builder()
                .deckId(1L)
                .deckTitle("IELTS Vocab")
                .direction("VI_EN")
                .mode(RoomMode.HUMAN)
                .build();

        CardBlastRoom room1 = pvpService.createRoom("4", "Alice", "/avatar1.png", req);
        assertNotNull(room1);
        assertEquals(6, room1.getRoomCode().length());
        assertEquals("4", room1.getHost().getUserId());
        assertNull(room1.getGuest());
        assertEquals(RoomStatus.WAITING, room1.getStatus());
        assertTrue(pvpService.isUserInRoom(room1.getRoomCode(), "4"));

        // Retried create commands return the same room instead of replacing it.
        CardBlastRoom room2 = pvpService.createRoom("4", "Alice", "/avatar1.png", req);
        assertNotNull(room2);
        assertSame(room1, room2);
        assertEquals(1, pvpService.getActiveRooms().size());
        assertTrue(pvpService.getActiveRooms().containsKey(room2.getRoomCode()));
    }

    @Test
    @DisplayName("Should create Bot Echo room with pre-filled guest slot and auto-start countdown")
    void shouldCreateBotRoom() {
        CreateRoomRequest req = CreateRoomRequest.builder()
                .deckId(2L)
                .deckTitle("TOEIC 500")
                .direction("VI_EN")
                .mode(RoomMode.BOT)
                .botLevel(BotLevel.NORMAL)
                .build();

        CardBlastRoom room = pvpService.createRoom("5", "Bob", "/avatar2.png", req);
        assertNotNull(room.getGuest());
        assertEquals("bot-echo", room.getGuest().getUserId());
        assertEquals("Bot Echo", room.getGuest().getDisplayName());
        assertTrue(room.getGuest().isReady());
        assertTrue(room.getHost().isReady());
        assertEquals(RoomStatus.COUNTDOWN, room.getStatus());
        assertNotNull(room.getMatchStartServerMs());
        assertTrue(room.getMatchStartServerMs() > System.currentTimeMillis());
    }

    @Test
    @DisplayName("Should resolve deck by slug when deckId is null")
    void shouldResolveDeckBySlugWhenDeckIdIsNull() {
        VocabDeck mockDeck = new VocabDeck();
        mockDeck.setId(42L);
        mockDeck.setSlug("4k-essential-book-1");
        mockDeck.setTitle("Book 1 - Nền tảng");
        Mockito.when(vocabDeckRepository.findBySlug("4k-essential-book-1")).thenReturn(java.util.Optional.of(mockDeck));

        CreateRoomRequest req = CreateRoomRequest.builder()
                .deckSlug("4k-essential-book-1")
                .mode(RoomMode.BOT)
                .build();

        CardBlastRoom room = pvpService.createRoom("4", "Alice", null, req);
        assertEquals(42L, room.getDeckId());
        assertEquals("Book 1 - Nền tảng", room.getDeckTitle());
        assertEquals(RoomStatus.COUNTDOWN, room.getStatus());
    }

    @Test
    @DisplayName("Should allow second player to join and reject joining when room is full")
    void shouldJoinRoomAndRejectWhenFull() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);

        CardBlastRoom joined = pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        assertNotNull(joined.getGuest());
        assertEquals("2", joined.getGuest().getUserId());
        assertTrue(pvpService.isUserInRoom(room.getRoomCode(), "2"));

        // Third player joining should fail
        assertThrows(IllegalStateException.class, () ->
                pvpService.joinRoom("3", "Intruder", null, room.getRoomCode()));
    }

    @Test
    @DisplayName("Should start countdown when both players toggle ready")
    void shouldStartCountdownWhenBothReady() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());

        pvpService.setReady("1", room.getRoomCode(), true);
        assertEquals(RoomStatus.WAITING, room.getStatus());

        pvpService.setReady("2", room.getRoomCode(), true);
        assertEquals(RoomStatus.COUNTDOWN, room.getStatus());
        assertNotNull(room.getMatchStartServerMs());
        assertTrue(room.getMatchStartServerMs() > System.currentTimeMillis());
    }

    @Test
    @DisplayName("Should validate applyHit: window, unresolved seq, and anti-macro guard")
    void shouldValidateApplyHit() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        ScheduledWord firstWord = room.getSchedule().get(0);
        int seq = firstWord.getSeq();
        long spawnAt = firstWord.getSpawnAtMs();
        long fallDuration = firstWord.getFallDurationMs();
        room.setMatchStartServerMs(System.currentTimeMillis() - spawnAt - 600);

        // 1. Anti-macro guard check: elapsed < 40ms * wordLength -> reject
        boolean tooFast = pvpService.applyHit(room.getRoomCode(), "1", seq, spawnAt + 10);
        assertFalse(tooFast);

        // 2. Out of window check: tMs > spawnAt + fallDuration + 400 -> reject
        boolean tooLate = pvpService.applyHit(room.getRoomCode(), "1", seq, spawnAt + fallDuration + 500);
        assertFalse(tooLate);

        // 3. Valid hit -> success
        long validTMs = spawnAt + 500;
        boolean hitSuccess = pvpService.applyHit(room.getRoomCode(), "1", seq, validTMs);
        assertTrue(hitSuccess);

        PlayerState host = room.getHost();
        assertEquals(1, host.getHits());
        assertEquals(1, host.getStreak());
        assertEquals(CardBlastPvPConstants.BASE_SCORE_PER_HIT, host.getScore());
        assertTrue(host.getResolvedSeqs().contains(seq));

        // 4. Duplicate hit on resolved seq -> reject
        boolean duplicateHit = pvpService.applyHit(room.getRoomCode(), "1", seq, validTMs + 100);
        assertFalse(duplicateHit);
    }

    @Test
    @DisplayName("Should accept hit with server time fallback when tMs is zero or negative")
    void shouldAcceptHitWithServerTimeFallbackWhenTMsIsZero() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        ScheduledWord firstWord = room.getSchedule().get(0);
        int seq = firstWord.getSeq();
        long spawnAt = firstWord.getSpawnAtMs();

        // Simulate server clock having elapsed spawnAt + 600ms
        room.setMatchStartServerMs(System.currentTimeMillis() - spawnAt - 600);

        boolean hitSuccess = pvpService.applyHit(room.getRoomCode(), "1", seq, 0L);
        assertTrue(hitSuccess, "Hit with tMs=0 should fallback to server elapsed match time and succeed");

        PlayerState host = room.getHost();
        assertEquals(1, host.getHits());
        assertEquals(1, host.getStreak());
        assertEquals(CardBlastPvPConstants.BASE_SCORE_PER_HIT, host.getScore());
        assertTrue(host.getResolvedSeqs().contains(seq));
        assertTrue(host.getTotalReactionTimeMs() > 0);
        assertEquals(1, host.getReactionCount());
    }

    @Test
    @DisplayName("Should deserialize HitRequest JSON with tMs property properly")
    void shouldDeserializeHitRequestWithTMs() throws Exception {
        com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        String json = "{\"roomCode\":\"ABCDEF\",\"seq\":1,\"tMs\":1500}";
        com.englishcoach.flashcard.pvp.dto.PvPRequests.HitRequest req = mapper.readValue(json, com.englishcoach.flashcard.pvp.dto.PvPRequests.HitRequest.class);
        assertEquals("ABCDEF", req.getRoomCode());
        assertEquals(1, req.getSeq());
        assertEquals(1500L, req.getTMs());
    }

    @Test
    @DisplayName("Should apply miss and terminate match on K.O. when HP reaches 0")
    void shouldTerminateOnKO() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        // Reduce host HP to 10
        room.getHost().setHp(10);

        ScheduledWord word = room.getSchedule().get(0);
        pvpService.applyMiss(room, room.getHost(), word.getSeq());

        assertEquals(0, room.getHost().getHp());
        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("KO", room.getEndReason());
        assertEquals("2", room.getWinnerId());
    }

    @Test
    @DisplayName("Client gameover cannot manufacture a KO while authoritative HP is positive")
    void shouldHandleClientGameOver() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        pvpService.handleClientGameOver("1", room.getRoomCode(), "KO");

        assertEquals(100, room.getHost().getHp());
        assertEquals(RoomStatus.IN_GAME, room.getStatus());
        assertNull(room.getEndReason());
    }

    @Test
    @DisplayName("Should evaluate words exhausted: higher HP wins -> higher score wins -> DRAW")
    void shouldEvaluateWordsExhausted() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.IN_GAME);

        // Case 1: Host has higher HP
        room.getSchedule().forEach(w -> {
            room.getHost().getResolvedSeqs().add(w.getSeq());
            room.getGuest().getResolvedSeqs().add(w.getSeq());
        });
        room.getHost().setHp(90);
        room.getGuest().setHp(70);
        pvpService.terminateMatch(room, "WORDS_EXHAUSTED");
        assertEquals("1", room.getWinnerId());

        // Case 2: Equal HP, Guest has higher score
        room.setStatus(RoomStatus.IN_GAME);
        room.getHost().setHp(80);
        room.getGuest().setHp(80);
        room.getHost().setScore(300);
        room.getGuest().setScore(500);
        pvpService.terminateMatch(room, "WORDS_EXHAUSTED");
        assertEquals("2", room.getWinnerId());

        // Case 3: Equal HP and equal score -> DRAW
        room.setStatus(RoomStatus.IN_GAME);
        room.getHost().setScore(500);
        pvpService.terminateMatch(room, "WORDS_EXHAUSTED");
        assertEquals("DRAW", room.getWinnerId());
    }

    @Test
    @DisplayName("Should handle 15-second disconnect grace period and rejoin")
    void shouldHandleDisconnectGracePeriodAndRejoin() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.IN_GAME);

        // Disconnect host
        pvpService.handleUserDisconnect("1");
        assertFalse(room.getHost().isConnected());
        assertNotNull(room.getHost().getDisconnectDeadlineMs());
        assertEquals(RoomStatus.IN_GAME, room.getStatus());

        // Rejoin before deadline
        CardBlastRoom rejoined = pvpService.rejoinRoom("1", room.getRoomCode());
        assertTrue(rejoined.getHost().isConnected());
        assertNull(rejoined.getHost().getDisconnectDeadlineMs());
    }

    @Test
    @DisplayName("Should forfeit match if disconnect deadline expires")
    void shouldForfeitOnDeadlineExpiry() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.IN_GAME);

        pvpService.handleUserDisconnect("1");
        // Simulate expired deadline
        room.getHost().setDisconnectDeadlineMs(System.currentTimeMillis() - 1000);

        // Run game loop tick
        pvpService.gameLoopTick();

        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("FORFEIT", room.getEndReason());
        assertEquals("2", room.getWinnerId());
    }

    @Test
    @DisplayName("Should reset match for rematch on mutual accept")
    void shouldResetMatchOnMutualRematch() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.FINISHED);

        pvpService.requestRematch("1", room.getRoomCode());
        assertTrue(room.getHost().isRematchRequested());
        assertEquals(RoomStatus.FINISHED, room.getStatus());

        pvpService.requestRematch("2", room.getRoomCode());
        assertEquals(RoomStatus.WAITING, room.getStatus());
        assertEquals(CardBlastPvPConstants.STARTING_HP, room.getHost().getHp());
        assertEquals(CardBlastPvPConstants.STARTING_HP, room.getGuest().getHp());
        assertFalse(room.getHost().isReady());
        assertFalse(room.getGuest().isReady());
    }

    @Test
    @DisplayName("Should purge stale idle rooms during cleanup task")
    void shouldPurgeStaleRooms() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);

        // Simulate idle for 11 minutes
        room.setLastActivityAt(System.currentTimeMillis() - (11 * 60 * 1000L));

        pvpService.cleanupStaleRooms();
        assertFalse(pvpService.getActiveRooms().containsKey(room.getRoomCode()));
    }

    @Test
    @DisplayName("Should dissolve room and broadcast ROOM_DISSOLVED when host leaves in WAITING status")
    void shouldDissolveRoomAndNotifyGuestWhenHostLeaves() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        assertEquals(RoomStatus.WAITING, room.getStatus());

        pvpService.leaveRoom("1", room.getRoomCode());

        assertFalse(pvpService.getActiveRooms().containsKey(room.getRoomCode()));
        Mockito.verify(messagingTemplate).convertAndSend(
                Mockito.eq("/topic/pvp/" + room.getRoomCode()),
                Mockito.argThat((Object msg) -> {
                    if (msg instanceof com.englishcoach.flashcard.pvp.dto.PvPMessage pvpMsg) {
                        return "ROOM_DISSOLVED".equals(pvpMsg.getType());
                    }
                    return false;
                })
        );
    }

    @Test
    @DisplayName("Should remove guest and keep host when guest leaves in WAITING status")
    void shouldRemoveGuestAndKeepHostWhenGuestLeaves() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());

        pvpService.leaveRoom("2", room.getRoomCode());

        assertTrue(pvpService.getActiveRooms().containsKey(room.getRoomCode()));
        assertNull(room.getGuest());
        assertNotNull(room.getHost());
        assertEquals("1", room.getHost().getUserId());
    }

    @Test
    @DisplayName("Should award victory to opponent when player leaves during match")
    void shouldAwardVictoryToOpponentWhenPlayerLeavesDuringGame() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        // Host leaves during match
        pvpService.leaveRoom("1", room.getRoomCode());

        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("FORFEIT", room.getEndReason());
        assertEquals("2", room.getWinnerId());
        assertEquals(0, room.getHost().getHp());
        assertFalse(room.getHost().isConnected());
    }

    @Test
    @DisplayName("Should block rematch when match ended due to forfeit")
    void shouldBlockRematchWhenMatchEndedDueToForfeit() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        pvpService.leaveRoom("1", room.getRoomCode());
        assertEquals(RoomStatus.FINISHED, room.getStatus());

        // Guest attempts to request rematch
        pvpService.requestRematch("2", room.getRoomCode());

        // Status should NOT reset to WAITING
        assertEquals(RoomStatus.FINISHED, room.getStatus());
        Mockito.verify(messagingTemplate).convertAndSendToUser(
                Mockito.eq("2"),
                Mockito.eq("/queue/pvp"),
                Mockito.argThat((Object msg) -> {
                    if (msg instanceof com.englishcoach.flashcard.pvp.dto.PvPMessage pvpMsg) {
                        return "ERROR".equals(pvpMsg.getType()) &&
                                pvpMsg.getPayload() != null &&
                                pvpMsg.getPayload().toString().contains("Đối thủ đã rời đi");
                    }
                    return false;
                })
        );
    }

    @Test
    @DisplayName("Should permit joining room in FINISHED state and reset to WAITING")
    void shouldPermitJoiningRoomInFinishedState() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.FINISHED);

        // A new guest joins the finished room
        CardBlastRoom joinedRoom = pvpService.joinRoom("3", "New Guest", null, room.getRoomCode());

        assertEquals(RoomStatus.WAITING, joinedRoom.getStatus());
        assertNotNull(joinedRoom.getGuest());
        assertEquals("3", joinedRoom.getGuest().getUserId());
        assertEquals(CardBlastPvPConstants.STARTING_HP, joinedRoom.getHost().getHp());
        assertFalse(joinedRoom.getHost().isReady());
    }

    @Test
    @DisplayName("Should reset room to WAITING when host requests rematch after guest leaves")
    void shouldResetRoomToWaitingWhenHostRequestsRematchSolo() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.FINISHED);

        // Guest leaves
        pvpService.leaveRoom("2", room.getRoomCode());
        assertEquals(RoomStatus.WAITING, room.getStatus());
        assertNull(room.getGuest());

        // Host requests rematch to wait in lobby
        pvpService.requestRematch("1", room.getRoomCode());
        assertEquals(RoomStatus.WAITING, room.getStatus());
        assertNull(room.getGuest());
    }

    @Test
    @DisplayName("Should reset room to WAITING when guest leaves finished room")
    void shouldResetRoomToWaitingWhenGuestLeavesFinishedRoom() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        room.setStatus(RoomStatus.FINISHED);

        pvpService.leaveRoom("2", room.getRoomCode());

        assertEquals(RoomStatus.WAITING, room.getStatus());
        assertNull(room.getGuest());
        assertNotNull(room.getHost());
        assertEquals("1", room.getHost().getUserId());
    }

    @Test
    @DisplayName("Should never trigger forfeit when player leaves or disconnects from finished room")
    void shouldNeverTriggerForfeitWhenLeavingOrDisconnectingFromFinishedRoom() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        // Match concludes normally via KO
        room.getGuest().setHp(0);
        pvpService.terminateMatch(room, "KO");
        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("KO", room.getEndReason());
        assertEquals("1", room.getWinnerId());

        // Guest leaves post-match
        pvpService.leaveRoom("2", room.getRoomCode());
        // Room resets to WAITING for host to rematch/wait for new guest; MUST NEVER be FORFEIT!
        assertNotEquals("FORFEIT", room.getEndReason());
        assertEquals(RoomStatus.WAITING, room.getStatus());

        // Host disconnects post-match from waiting room
        pvpService.handleUserDisconnect("1");
        assertTrue(pvpService.getActiveRooms().containsKey(room.getRoomCode()));
        assertNotNull(room.getHost().getDisconnectDeadlineMs());
    }

    @Test
    @DisplayName("Should terminate as KO instead of forfeit when leaving with zero HP")
    void shouldTerminateAsKoWhenLeavingWithZeroHp() {
        CreateRoomRequest req = CreateRoomRequest.builder().mode(RoomMode.HUMAN).build();
        CardBlastRoom room = pvpService.createRoom("1", "Host", null, req);
        pvpService.joinRoom("2", "Guest", null, room.getRoomCode());
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        // Host HP reached 0
        room.getHost().setHp(0);
        pvpService.leaveRoom("1", room.getRoomCode());

        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("KO", room.getEndReason());
        assertEquals("2", room.getWinnerId());
    }
}
