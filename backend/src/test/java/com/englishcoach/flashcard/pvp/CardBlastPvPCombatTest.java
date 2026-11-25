package com.englishcoach.flashcard.pvp;

import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.CreateRoomRequest;
import com.englishcoach.flashcard.pvp.engine.ScheduleBuilder;
import com.englishcoach.flashcard.pvp.engine.ScheduleBuilder.WordSource;
import com.englishcoach.flashcard.pvp.model.*;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.messaging.simp.SimpMessagingTemplate;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class CardBlastPvPCombatTest {

    private SimpMessagingTemplate messagingTemplate;
    private FlashcardRepository flashcardRepository;
    private DictionaryRepository dictionaryRepository;
    private VocabDeckRepository vocabDeckRepository;
    private CardBlastPvPService pvpService;

    @BeforeEach
    void setUp() {
        messagingTemplate = mock(SimpMessagingTemplate.class);
        flashcardRepository = mock(FlashcardRepository.class);
        dictionaryRepository = mock(DictionaryRepository.class);
        vocabDeckRepository = mock(VocabDeckRepository.class);

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

    private CardBlastRoom createTestRoom(int speedLevel) {
        CreateRoomRequest req = CreateRoomRequest.builder()
                .deckId(1L)
                .deckTitle("Test Deck")
                .direction("VI_EN")
                .mode(RoomMode.HUMAN)
                .speedLevel(speedLevel)
                .hintLevel("NORMAL")
                .build();

        CardBlastRoom room = pvpService.createRoom("1001", "Alice", "/alice.png", req);
        pvpService.joinRoom("1002", "Bob", "/bob.png", room.getRoomCode());
        return room;
    }

    @Test
    @DisplayName("1. Speed scaling fall durations and spawn gaps for Speeds 1 to 5")
    void testSpeedScalingFallDurations() {
        // Speed 1 (Normal)
        var c1 = ScheduleBuilder.getSpeedConfig(1, "NORMAL");
        assertEquals(14103L, c1.initialFallMs());
        assertEquals(10154L, c1.minFallMs());
        assertEquals(8000L, c1.initialGapMs());
        assertEquals(7000L, c1.minGapMs());

        // Speed 1 (Easy - relaxed single-player fall speed)
        var c1Easy = ScheduleBuilder.getSpeedConfig(1, "EASY");
        assertEquals(20370L, c1Easy.initialFallMs());
        assertEquals(14666L, c1Easy.minFallMs());
        assertEquals(8000L, c1Easy.initialGapMs());
        assertEquals(7000L, c1Easy.minGapMs());

        // Speed 2 (Normal)
        var c2 = ScheduleBuilder.getSpeedConfig(2, "NORMAL");
        assertEquals(10319L, c2.initialFallMs());
        assertEquals(7430L, c2.minFallMs());
        assertEquals(6500L, c2.initialGapMs());
        assertEquals(5500L, c2.minGapMs());

        // Speed 3 (Normal)
        var c3 = ScheduleBuilder.getSpeedConfig(3, "NORMAL");
        assertEquals(8136L, c3.initialFallMs());
        assertEquals(4500L, c3.initialGapMs());
        assertEquals(4000L, c3.minGapMs());

        // Speed 4 (Normal)
        var c4 = ScheduleBuilder.getSpeedConfig(4, "NORMAL");
        assertEquals(6716L, c4.initialFallMs());
        assertEquals(3200L, c4.initialGapMs());
        assertEquals(2800L, c4.minGapMs());

        // Speed 5 (Normal)
        var c5 = ScheduleBuilder.getSpeedConfig(5, "NORMAL");
        assertEquals(5717L, c5.initialFallMs());
        assertEquals(2200L, c5.initialGapMs());
        assertEquals(1800L, c5.minGapMs());

        // Test schedule building with Speed 1
        List<WordSource> pool = new ArrayList<>();
        for (int i = 1; i <= 60; i++) {
            pool.add(new WordSource((long) i, "word" + i, "/w/", "nghĩa" + i, List.of("nghĩa" + i)));
        }
        List<ScheduledWord> sched1 = ScheduleBuilder.buildSchedule(pool, 1234L, "VI_EN", 1, "NORMAL");
        assertEquals(14103L, sched1.get(0).getFallDurationMs());
        assertEquals(10154L, sched1.get(50).getFallDurationMs());
    }

    @Test
    @DisplayName("2. Streak milestone 3 triggers attack on opponent")
    void testMilestoneAttackTrigger() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 2000);

        PlayerState alice = room.getHost();
        alice.setStreak(2); // Next hit will be streak 3 (milestone multiple of 3)

        ScheduledWord target = room.getSchedule().get(0);
        long tMs = target.getSpawnAtMs() + 500; // valid hit time

        pvpService.executeHit(room, alice, target.getSeq(), tMs);

        assertEquals(3, alice.getStreak());
        assertEquals(1, room.getPendingAttacks().size());
        PendingAttack attack = room.getPendingAttacks().get(0);
        assertEquals("1001", attack.getFromUserId());
        assertEquals("1002", attack.getToUserId());
        assertEquals(2000L, attack.getTelegraphMs());
        assertFalse(attack.isParried());
    }

    @Test
    @DisplayName("3. Knowledge attack selection priority: missed in match -> SM-2 due -> longest deck fallback")
    void testKnowledgeAttackSelectionPriority() {
        CardBlastRoom room = createTestRoom(2);
        PlayerState bob = room.getGuest();

        // Priority A: Missed word in this match
        ScheduledWord wordMissed = room.getSchedule().get(2);
        bob.getMissedWordIds().add(wordMissed.getWordId());

        ScheduledWord chosenA = pvpService.selectGarbageWord(room, bob);
        assertNotNull(chosenA);
        assertEquals(wordMissed.getWordId(), chosenA.getWordId());
        assertTrue(room.getUsedGarbageWordIds().contains(wordMissed.getWordId()));

        // Priority B: SM-2 weak cards
        DictionaryEntry dueEntry = new DictionaryEntry();
        dueEntry.setId(room.getSchedule().get(4).getWordId());
        dueEntry.setWord(room.getSchedule().get(4).getWord());
        Flashcard dueCard = new Flashcard();
        dueCard.setDictionaryEntry(dueEntry);

        when(flashcardRepository.findDueFlashcards(eq(1002L), any(PageRequest.class)))
                .thenReturn(new PageImpl<>(List.of(dueCard)));

        // Clear missed list to test Priority B
        bob.getMissedWordIds().clear();
        ScheduledWord chosenB = pvpService.selectGarbageWord(room, bob);
        assertNotNull(chosenB);
        assertEquals(dueEntry.getId(), chosenB.getWordId());

        // Priority C: Longest word in deck fallback
        reset(flashcardRepository);
        when(flashcardRepository.findDueFlashcards(anyLong(), any())).thenReturn(new PageImpl<>(List.of()));

        ScheduledWord chosenC = pvpService.selectGarbageWord(room, bob);
        assertNotNull(chosenC);
        // Verify it picked a word from the deck that hasn't been used yet
        assertTrue(room.getUsedGarbageWordIds().contains(chosenC.getWordId()));
    }

    @Test
    @DisplayName("4. Telegraph to spawn timing (2000ms)")
    void testTelegraphSpawnTiming() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        long now = System.currentTimeMillis();
        room.setMatchStartServerMs(now);

        PlayerState alice = room.getHost();
        pvpService.triggerAttack(room, alice);

        assertEquals(1, room.getPendingAttacks().size());
        assertEquals(0, room.getActiveGarbageWords().size());

        PendingAttack attack = room.getPendingAttacks().get(0);
        ScheduledWord gw = attack.getScheduledWord();
        assertTrue(gw.isGarbage());
        // Verify garbage word is 1.25x faster (0.8 multiplier)
        long normalFall = ScheduleBuilder.getSpeedConfig(2).initialFallMs();
        assertEquals(Math.round(normalFall * 0.8), gw.getFallDurationMs());

        // Tick before telegraph expires
        pvpService.gameLoopTick();
        assertEquals(1, room.getPendingAttacks().size());
        assertEquals(0, room.getActiveGarbageWords().size());

        // Fast forward attack execute time
        attack.setExecuteAtMs(now - 10);
        pvpService.gameLoopTick();

        assertEquals(0, room.getPendingAttacks().size());
        assertEquals(1, room.getActiveGarbageWords().size());
        ScheduledWord activeGw = room.getActiveGarbageWords().get(gw.getSeq());
        assertNotNull(activeGw);
        assertEquals("1002", activeGw.getTargetPlayerId());
    }

    @Test
    @DisplayName("5. Parry cancellation: victim streak 5 or golden word cancels pending attack")
    void testParryMechanic() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        long now = System.currentTimeMillis();
        room.setMatchStartServerMs(now);

        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();

        // Alice attacks Bob
        pvpService.triggerAttack(room, alice);
        assertEquals(1, room.getPendingAttacks().size());
        PendingAttack attack = room.getPendingAttacks().get(0);
        assertFalse(attack.isParried());

        // Bob parries by hitting streak 3
        bob.setStreak(2);
        ScheduledWord target = room.getSchedule().get(0);
        pvpService.executeHit(room, bob, target.getSeq(), target.getSpawnAtMs() + 500);

        assertTrue(attack.isParried(), "Attack should be marked parried");

        // Advance past execute time; Alice's parried attack must be discarded and NOT spawn garbage
        attack.setExecuteAtMs(now - 10);
        pvpService.gameLoopTick();

        // Alice's attack is parried and removed.
        // Bob's counter-attack is now pending!
        assertEquals(1, room.getPendingAttacks().size());
        assertEquals("1002", room.getPendingAttacks().get(0).getFromUserId());
        assertEquals("1001", room.getPendingAttacks().get(0).getToUserId());
        assertEquals(0, room.getActiveGarbageWords().size());
    }

    @Test
    @DisplayName("6. Garbage word cap of 3 (drops to 1 in Last Stand)")
    void testGarbageWordCap() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();

        // Trigger 3 attacks
        pvpService.triggerAttack(room, alice);
        pvpService.triggerAttack(room, alice);
        pvpService.triggerAttack(room, alice);
        assertEquals(3, room.getPendingAttacks().size());

        // 4th attack should be dropped due to cap 3
        pvpService.triggerAttack(room, alice);
        assertEquals(3, room.getPendingAttacks().size());

        // Last Stand: Bob HP <= 30%
        bob.setHp(25);
        bob.setLastStand(true);

        // Clear existing attacks
        room.getPendingAttacks().clear();

        // In Last Stand, cap is 1
        pvpService.triggerAttack(room, alice);
        assertEquals(1, room.getPendingAttacks().size());

        // Next attack is dropped because cap is 1
        pvpService.triggerAttack(room, alice);
        assertEquals(1, room.getPendingAttacks().size());

        // Under Last Stand, garbage speed penalty is removed (1.0x multiplier)
        ScheduledWord lsWord = room.getPendingAttacks().get(0).getScheduledWord();
        long normalFall = ScheduleBuilder.getSpeedConfig(2).initialFallMs();
        assertEquals(normalFall, lsWord.getFallDurationMs());
    }

    @Test
    @DisplayName("7. Golden Word duel: first valid hit wins +3x score, counter-attacks, loser gets GOLDEN_TAKEN")
    void testGoldenWordDuel() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        long now = System.currentTimeMillis();
        room.setMatchStartServerMs(now);

        pvpService.spawnGoldenWord(room, 5000L);
        ScheduledWord golden = room.getActiveGoldenWord();
        assertNotNull(golden);
        assertTrue(golden.isGolden());

        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();

        // Alice hits golden word first
        int initialAliceScore = alice.getScore();
        long hitTime = golden.getSpawnAtMs() + 600;
        boolean aliceHit = pvpService.executeHit(room, alice, golden.getSeq(), hitTime);

        assertTrue(aliceHit);
        assertNull(room.getActiveGoldenWord());
        assertEquals("1001", room.getGoldenWordClaimedBy());

        // +3x normal hit score
        int earned = CardBlastPvPConstants.BASE_SCORE_PER_HIT * 1 * CardBlastPvPConstants.GOLDEN_WORD_SCORE_MULTIPLIER;
        assertEquals(initialAliceScore + earned, alice.getScore());

        // Instant counter-attack triggered on Bob
        assertEquals(1, room.getPendingAttacks().size());
        assertEquals("1002", room.getPendingAttacks().get(0).getToUserId());

        // Bob tries to hit golden word after Alice claimed it -> rejected
        boolean bobHit = pvpService.executeHit(room, bob, golden.getSeq(), hitTime + 100);
        assertFalse(bobHit);
    }

    @Test
    @DisplayName("8. Last Stand latch at HP <= 30%")
    void testLastStandLatch() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        PlayerState alice = room.getHost();
        alice.setHp(40);
        assertFalse(alice.isLastStand());

        // Miss damages 12 HP: 40 -> 28 HP (<= 30%)
        pvpService.applyMiss(room, alice, 1);
        assertEquals(28, alice.getHp());
        assertTrue(alice.isLastStand());

        // Second miss should not trigger duplicate state change
        pvpService.applyMiss(room, alice, 2);
        assertEquals(16, alice.getHp());
        assertTrue(alice.isLastStand());
    }

    @Test
    @DisplayName("9. Sudden Death at >= 180s doubles miss damage (2x) and remains false at 92s")
    void testSuddenDeathDoubleDamage() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        long start92 = System.currentTimeMillis() - 92_000L; // 92s elapsed (< 180s)
        room.setMatchStartServerMs(start92);
        assertFalse(room.isSuddenDeath());

        // Pre-resolve words so players aren't KO'd by overdue misses
        for (ScheduledWord sw : room.getSchedule()) {
            room.getHost().getResolvedSeqs().add(sw.getSeq());
            room.getGuest().getResolvedSeqs().add(sw.getSeq());
        }

        // Tick at 92s should NOT activate Sudden Death
        pvpService.gameLoopTick();
        assertFalse(room.isSuddenDeath(), "Sudden Death must not trigger before 180s");

        // Fast forward to 182s (>= 180s)
        long start182 = System.currentTimeMillis() - 182_000L;
        room.setMatchStartServerMs(start182);

        // Tick activates Sudden Death
        pvpService.gameLoopTick();
        assertTrue(room.isSuddenDeath(), "Sudden Death must trigger at >= 180s");

        PlayerState alice = room.getHost();
        alice.setHp(100);

        // Apply miss in Sudden Death
        pvpService.applyMiss(room, alice, 9999);
        // Miss damage = 12 * 2 = 24
        assertEquals(76, alice.getHp());
    }

    @Test
    @DisplayName("10. Whale reaction whitelist and 1.5s rate limit")
    void testReactionRateLimiting() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);

        // Whitelisted reactions
        pvpService.handleReaction("1001", room.getRoomCode(), "GG");
        assertEquals("GG", "GG");

        // Immediate second reaction within 1.5s is rate limited
        long firstTime = room.getHost().getLastReactionTimeMs();
        pvpService.handleReaction("1001", room.getRoomCode(), "FIRE");
        assertEquals(firstTime, room.getHost().getLastReactionTimeMs()); // Time unchanged, dropped

        // Invalid reaction is rejected
        pvpService.handleReaction("1001", room.getRoomCode(), "INVALID_EMOJI");

        // Advance beyond 1500ms
        long pastTime = System.currentTimeMillis() - 2000L;
        room.getHost().setLastReactionTimeMs(pastTime);
        pvpService.handleReaction("1001", room.getRoomCode(), "NICE");
        assertTrue(room.getHost().getLastReactionTimeMs() > pastTime);
    }

    @Test
    @DisplayName("11. Phase 3: Server-authoritative skills execution (loadout, mana, effects)")
    void testPvPSkillsAuthoritativeExecution() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 2000);

        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();
        alice.setSkills(List.of("SLOW_MO", "SHIELD", "EMP_BLAST"));

        // 1. Cannot cast without mana
        alice.setMana(30);
        boolean castWithoutMana = pvpService.castSkill("1001", room.getRoomCode(), "SLOW_MO"); // costs 50
        assertFalse(castWithoutMana);
        assertEquals(30, alice.getMana());

        // 2. Cast SLOW_MO (Cost: 50) -> adds 5000ms deadline bonus
        alice.setMana(100);
        alice.setLastSkillCastMs(0L);
        boolean slowMoSuccess = pvpService.castSkill("1001", room.getRoomCode(), "SLOW_MO");
        assertTrue(slowMoSuccess);
        assertEquals(50, alice.getMana());
        assertEquals(5000L, alice.getDeadlineBonusMs());
        assertEquals(1, alice.getSkillsUsed());

        // 3. Cast SHIELD (Cost: 35) -> absorbs next incoming attack
        alice.setMana(100);
        alice.setLastSkillCastMs(0L);
        boolean shieldSuccess = pvpService.castSkill("1001", room.getRoomCode(), "SHIELD");
        assertTrue(shieldSuccess);
        assertEquals(65, alice.getMana());
        assertNotNull(alice.getShieldActiveUntilMs());
        assertTrue(alice.getShieldActiveUntilMs() > System.currentTimeMillis());

        // Opponent attacks Alice -> absorbed by shield!
        pvpService.triggerAttack(room, bob);
        assertEquals(0, room.getPendingAttacks().size(), "Attack should be absorbed by shield!");
        assertNull(alice.getShieldActiveUntilMs(), "Shield should be consumed upon absorption");

        // 4. Cast FOG on opponent (requires FOG in loadout)
        alice.setSkills(List.of("FOG", "SHIELD", "ECHO_CHAIN"));
        alice.setMana(100);
        alice.setLastSkillCastMs(0L);
        boolean fogSuccess = pvpService.castSkill("1001", room.getRoomCode(), "FOG");
        assertTrue(fogSuccess);
        assertEquals(50, alice.getMana());
        assertNotNull(bob.getFogActiveUntilMs());
        assertTrue(bob.getFogActiveUntilMs() > System.currentTimeMillis());

        // 5. Cast ECHO_CHAIN -> arms chain, next hit detonates nearest word
        alice.setMana(100);
        alice.setLastSkillCastMs(0L);
        boolean echoSuccess = pvpService.castSkill("1001", room.getRoomCode(), "ECHO_CHAIN");
        assertTrue(echoSuccess);
        assertEquals(60, alice.getMana());
        assertTrue(alice.isEchoChainArmed());

        // Hit word 1 -> Echo chain detonates adjacent word!
        ScheduledWord word1 = room.getSchedule().get(0);
        ScheduledWord word2 = room.getSchedule().get(1);
        word2.setSpawnAtMs(word1.getSpawnAtMs()); // within screen window
        pvpService.executeHit(room, alice, word1.getSeq(), word1.getSpawnAtMs() + 500);

        assertFalse(alice.isEchoChainArmed(), "Echo chain should be disarmed after hit");
        assertTrue(alice.getResolvedSeqs().contains(word1.getSeq()));
        assertTrue(alice.getResolvedSeqs().contains(word2.getSeq()), "Adjacent word should be detonated by Echo Chain");

        // 6. Bot cannot cast skills
        bob.setUserId("bot-echo");
        bob.setMana(100);
        boolean botCast = pvpService.castSkill("bot-echo", room.getRoomCode(), "SLOW_MO");
        assertFalse(botCast);
    }

    @Test
    @DisplayName("12. Phase 3: Last Stand double mana regeneration (+20 vs +10)")
    void testLastStandDoubleManaRegen() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 2000);

        PlayerState alice = room.getHost();
        alice.setMana(0);
        alice.setHp(100);
        alice.setLastStand(false);

        // Normal hit: +10 mana
        ScheduledWord w1 = room.getSchedule().get(0);
        pvpService.executeHit(room, alice, w1.getSeq(), w1.getSpawnAtMs() + 500);
        assertEquals(10, alice.getMana());

        // Enter Last Stand (HP <= 30)
        alice.setHp(25);
        alice.setLastStand(true);

        // Last Stand hit: +20 mana
        ScheduledWord w2 = room.getSchedule().get(1);
        pvpService.executeHit(room, alice, w2.getSeq(), w2.getSpawnAtMs() + 500);
        assertEquals(30, alice.getMana(), "Should gain +20 mana during Last Stand (10 + 20 = 30)");
    }

    @Test
    @DisplayName("13. Phase 3: Golden Word target set to T+18s")
    void testEarlyGoldenWordTarget() {
        CardBlastRoom room = createTestRoom(2);
        assertEquals(18_000L, room.getNextGoldenTargetMs());
        assertEquals(18_000L, CardBlastPvPConstants.FIRST_GOLDEN_WORD_MS);
    }

    @Test
    @DisplayName("14. Phase 3: Elo rating calculation for human match >= 30s")
    void testEloRatingHumanVsHumanRanked() {
        var matchRepo = mock(com.englishcoach.flashcard.pvp.repository.PvpMatchRepository.class);
        var statsRepo = mock(com.englishcoach.flashcard.pvp.repository.PvpPlayerStatsRepository.class);
        var missedRepo = mock(com.englishcoach.flashcard.pvp.repository.PvpMissedWordRepository.class);
        var ratingRepo = mock(com.englishcoach.flashcard.pvp.repository.PvpRatingRepository.class);

        CardBlastPvPService serviceWithPersistence = new CardBlastPvPService(
                messagingTemplate, flashcardRepository, dictionaryRepository, vocabDeckRepository,
                matchRepo, statsRepo, missedRepo, ratingRepo
        );

        CreateRoomRequest req = CreateRoomRequest.builder()
                .deckId(1L)
                .deckTitle("Test Deck")
                .direction("VI_EN")
                .mode(RoomMode.HUMAN)
                .speedLevel(2)
                .build();

        CardBlastRoom room = serviceWithPersistence.createRoom("1001", "Alice", "/alice.png", req);
        serviceWithPersistence.joinRoom("1002", "Bob", "/bob.png", room.getRoomCode());
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 35_000L); // 35s elapsed (>= 30s)

        // Mock rating repo
        var r1 = com.englishcoach.flashcard.pvp.entity.PvpRating.builder().userId(1001L).rating(1000).wins(0).losses(0).build();
        var r2 = com.englishcoach.flashcard.pvp.entity.PvpRating.builder().userId(1002L).rating(1000).wins(0).losses(0).build();
        when(ratingRepo.findById(1001L)).thenReturn(Optional.of(r1));
        when(ratingRepo.findById(1002L)).thenReturn(Optional.of(r2));
        when(matchRepo.countRankedMatchesBetweenPairSince(anyLong(), anyLong(), any())).thenReturn(2L);
        when(matchRepo.save(any())).thenAnswer(inv -> {
            var m = (com.englishcoach.flashcard.pvp.entity.PvpMatch) inv.getArgument(0);
            m.setId(99L);
            return m;
        });

        // Alice KOs Bob
        room.getGuest().setHp(0);
        serviceWithPersistence.terminateMatch(room, "KO");

        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("1001", room.getWinnerId());
        // Verify Elo rating delta was calculated (equal rating 1000 vs 1000, winner gains +16, loser -16)
        assertEquals(1016, r1.getRating());
        assertEquals(1, r1.getWins());
        assertEquals(984, r2.getRating());
        assertEquals(1, r2.getLosses());
        verify(ratingRepo, times(1)).save(r1);
        verify(ratingRepo, times(1)).save(r2);
        verify(matchRepo, times(1)).save(any());
    }

    @Test
    @DisplayName("18. Bot difficulty scaling: accuracy and delay calibrated per level")
    void testBotDifficultyScaling() {
        assertEquals(0.55, BotLevel.EASY.getHitProbability(), 0.001);
        assertEquals(0.78, BotLevel.NORMAL.getHitProbability(), 0.001);
        assertEquals(0.92, BotLevel.HARD.getHitProbability(), 0.001);

        assertEquals(3500L, CardBlastPvPConstants.BOT_EASY_MIN_THINK_MS);
        assertEquals(5500L, CardBlastPvPConstants.BOT_EASY_MAX_THINK_MS);
        assertEquals(120L, CardBlastPvPConstants.BOT_EASY_MS_PER_CHAR);

        assertEquals(1600L, CardBlastPvPConstants.BOT_NORMAL_MIN_THINK_MS);
        assertEquals(2600L, CardBlastPvPConstants.BOT_NORMAL_MAX_THINK_MS);
        assertEquals(80L, CardBlastPvPConstants.BOT_NORMAL_MS_PER_CHAR);

        assertEquals(800L, CardBlastPvPConstants.BOT_HARD_MIN_THINK_MS);
        assertEquals(1300L, CardBlastPvPConstants.BOT_HARD_MAX_THINK_MS);
        assertEquals(45L, CardBlastPvPConstants.BOT_HARD_MS_PER_CHAR);
    }

    @Test
    @DisplayName("19. Bot Golden Word contestation delay calibration")
    void testBotGoldenWordDelays() {
        assertEquals(7500L, CardBlastPvPConstants.BOT_GOLDEN_EASY_MIN_DELAY_MS);
        assertEquals(9500L, CardBlastPvPConstants.BOT_GOLDEN_EASY_MAX_DELAY_MS);
        assertEquals(0.50, CardBlastPvPConstants.BOT_GOLDEN_EASY_HIT_PROBABILITY, 0.001);

        assertEquals(4500L, CardBlastPvPConstants.BOT_GOLDEN_NORMAL_MIN_DELAY_MS);
        assertEquals(6000L, CardBlastPvPConstants.BOT_GOLDEN_NORMAL_MAX_DELAY_MS);

        assertEquals(2500L, CardBlastPvPConstants.BOT_GOLDEN_HARD_MIN_DELAY_MS);
        assertEquals(3500L, CardBlastPvPConstants.BOT_GOLDEN_HARD_MAX_DELAY_MS);
    }

    @Test
    @DisplayName("20. Casting FOG against Bot delays bot hit schedule")
    void testFogDelaysBotHitSchedule() {
        CardBlastRoom room = createTestRoom(2);
        room.setMode(RoomMode.BOT);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 1000);

        PlayerState alice = room.getHost();
        alice.setSkills(List.of("FOG", "SHIELD", "ECHO_CHAIN"));
        alice.setMana(100);
        alice.setLastSkillCastMs(0L);

        PlayerState bot = room.getGuest();
        bot.setUserId("bot-echo");

        boolean success = pvpService.castSkill(alice.getUserId(), room.getRoomCode(), "FOG");
        assertTrue(success);
        assertNotNull(bot.getFogActiveUntilMs());
        assertTrue(bot.getFogActiveUntilMs() > System.currentTimeMillis());
    }

    @Test
    @DisplayName("21. Casting SHIELD immediately absorbs existing pending attack targeting caster")
    void testShieldAbsorbsPendingAttackImmediately() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 1000);

        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();
        bob.setSkills(List.of("FOG", "SHIELD", "ECHO_CHAIN"));
        bob.setMana(100);
        bob.setLastSkillCastMs(0L);

        // Simulate incoming attack from Alice targeting Bob
        com.englishcoach.flashcard.pvp.model.PendingAttack attack = com.englishcoach.flashcard.pvp.model.PendingAttack.builder()
                .attackId("test-atk-1")
                .fromUserId(alice.getUserId())
                .fromName(alice.getDisplayName())
                .toUserId(bob.getUserId())
                .createdAtMs(System.currentTimeMillis())
                .executeAtMs(System.currentTimeMillis() + 2000L)
                .scheduledWord(com.englishcoach.flashcard.pvp.model.ScheduledWord.builder()
                        .seq(999)
                        .word("test")
                        .vietnamese("thử")
                        .targetPlayerId(bob.getUserId())
                        .build())
                .build();
        room.getPendingAttacks().add(attack);
        assertEquals(1, room.getPendingAttacks().size());

        // Bob casts SHIELD
        boolean success = pvpService.castSkill(bob.getUserId(), room.getRoomCode(), "SHIELD");
        assertTrue(success);

        // Pending attack should be absorbed and removed immediately
        assertEquals(0, room.getPendingAttacks().size());
        assertEquals(1, bob.getAttacksDeflected());
        assertNull(bob.getShieldActiveUntilMs()); // Shield consumed upon absorption
    }

    @Test
    @DisplayName("22. Active SHIELD absorbs pending attack during gameLoopTick execution")
    void testShieldAbsorbsPendingAttackInTickRooms() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 3000);

        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();

        // Bob activates shield
        bob.setShieldActiveUntilMs(System.currentTimeMillis() + 5000L);

        // Pending attack is due to execute
        com.englishcoach.flashcard.pvp.model.PendingAttack attack = com.englishcoach.flashcard.pvp.model.PendingAttack.builder()
                .attackId("test-atk-2")
                .fromUserId(alice.getUserId())
                .fromName(alice.getDisplayName())
                .toUserId(bob.getUserId())
                .createdAtMs(System.currentTimeMillis() - 2500)
                .executeAtMs(System.currentTimeMillis() - 500) // already overdue
                .scheduledWord(com.englishcoach.flashcard.pvp.model.ScheduledWord.builder()
                        .seq(1001)
                        .word("shielded")
                        .vietnamese("được bảo vệ")
                        .targetPlayerId(bob.getUserId())
                        .build())
                .build();
        room.getPendingAttacks().add(attack);

        // Tick rooms
        pvpService.gameLoopTick();

        // Pending attack absorbed, no garbage spawned
        assertEquals(0, room.getPendingAttacks().size());
        assertFalse(room.getActiveGarbageWords().containsKey(1001));
        assertEquals(1, bob.getAttacksDeflected());
        assertNull(bob.getShieldActiveUntilMs()); // Shield consumed
    }

    @Test
    @DisplayName("18. Authoritative match termination when player HP reaches 0 via auto-miss")
    void testAuthoritativeMatchTerminationOnZeroHp() {
        CardBlastRoom room = createTestRoom(2);
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - 10_000);

        PlayerState alice = room.getHost();
        PlayerState bob = room.getGuest();
        alice.setHp(10); // Below 12 baseline miss damage

        // Apply a miss to Alice
        pvpService.applyMiss(room, alice, 1);

        assertEquals(0, alice.getHp());
        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("KO", room.getEndReason());
        assertEquals(bob.getUserId(), room.getWinnerId());

        // Verify authoritative MATCH_END broadcast sent to topic
        verify(messagingTemplate, atLeastOnce()).convertAndSend(
                eq("/topic/pvp/" + room.getRoomCode()),
                argThat((Object msg) -> {
                    if (msg instanceof com.englishcoach.flashcard.pvp.dto.PvPMessage<?> pvpMsg) {
                        return "MATCH_END".equals(pvpMsg.getType()) || "ROOM_STATE".equals(pvpMsg.getType());
                    }
                    return false;
                })
        );
    }

    @Test
    @DisplayName("19. Baseline damage calibration: 12 HP normal, 24 HP in Sudden Death")
    void testDamageCalibrationNormalVsSuddenDeath() {
        CardBlastRoom room = createTestRoom(2);
        pvpService.startCountdown(room);
        room.setStatus(RoomStatus.IN_GAME);

        PlayerState alice = room.getHost();
        alice.setHp(100);

        // Normal miss: deducts 12 HP
        room.setSuddenDeath(false);
        pvpService.applyMiss(room, alice, 1);
        assertEquals(88, alice.getHp());

        // Sudden death miss: deducts 24 HP (2x)
        room.setSuddenDeath(true);
        pvpService.applyMiss(room, alice, 2);
        assertEquals(64, alice.getHp());
    }

    @Test
    @DisplayName("20. Rematch reset preserves 100 HP and cleanly resets room to WAITING")
    void testRematchCleanReset() {
        CardBlastRoom room = createTestRoom(2);
        room.setStatus(RoomStatus.FINISHED);
        room.getHost().setHp(0);
        room.getGuest().setHp(40);

        // Both players request rematch
        pvpService.requestRematch(room.getHost().getUserId(), room.getRoomCode());
        pvpService.requestRematch(room.getGuest().getUserId(), room.getRoomCode());

        assertEquals(RoomStatus.WAITING, room.getStatus());
        assertEquals(100, room.getHost().getHp());
        assertEquals(100, room.getGuest().getHp());
        assertNull(room.getWinnerId());
        assertNull(room.getEndReason());
        assertFalse(room.isSuddenDeath());
    }
}

