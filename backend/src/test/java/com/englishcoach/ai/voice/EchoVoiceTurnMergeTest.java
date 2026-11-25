package com.englishcoach.ai.voice;

import com.englishcoach.ai.controller.EchoTranscriptionController.Transcript;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.service.AiChatService;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.service.EchoCoachService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit and WS state-machine tests for premature-turn merging, overlap-free 480 ms preroll seam deduplication,
 * bare-vocative 2,400 ms hold, "High Echo" Plane-A parity, tail-silence partial promotion, superseded cancel-handle
 * quota race closure, explicit blank spokenText truncation, and pure spoken-prose sanitization.
 */
class EchoVoiceTurnMergeTest {

    private static byte[] pcm(int n, int fill) {
        byte[] b = new byte[n];
        Arrays.fill(b, (byte) fill);
        return b;
    }

    private static EchoVoiceWebSocketHandler.VoiceSessionState state() {
        return new EchoVoiceWebSocketHandler.VoiceSessionState(null, 7L, null);
    }

    @Test
    void lateFramesOfAnOlderTurnNeverEraseTheTurnBeingSpoken() {
        var s = state();
        s.resetForSpeechStart(3);
        s.appendMicPcm(3, 0, pcm(4_000, 3));
        assertFalse(s.appendMicPcm(2, 64_000, pcm(2_000, 2)), "a stale turn-2 frame is ignored");
        s.appendMicPcm(3, 4_000, pcm(1_000, 3));
        byte[] taken = s.takeAndClearPcm();
        assertEquals(5_000, taken.length);
        for (byte b : taken) assertEquals(3, b);
    }

    @Test
    void aFailedTurnClearsOnlyItsOwnAudioNeverTheNextTurns() {
        var s = state();
        s.resetForSpeechStart(3);
        s.appendMicPcm(3, 0, pcm(6_000, 3));
        s.clearPcmIfTurn(2); // turn 2's provider error arrives while turn 3 is being spoken
        assertEquals(6_000, s.takeAndClearPcm().length);
        s.resetForSpeechStart(4);
        s.appendMicPcm(4, 0, pcm(1_000, 4));
        s.clearPcmIfTurn(4);
        assertEquals(0, s.takeAndClearPcm().length);
    }

    @Test
    void speechResumingAfterAPrematureCommitMergesWithoutClippingOrDuplicatingPrerollAndSupports20sBuffer() {
        // 1. Pause >= 480 ms: zero preroll overlap with committed carry -> full carry + preroll preserved
        var sFull = state();
        long t0 = 1_000_000L;
        sFull.resetForSpeechStart(2);
        sFull.appendMicPcm(2, 0, pcm(28_000, 2)); // "Hi Echo,"
        sFull.beginResponse(2);
        byte[] committed = sFull.takeAndClearPcm();
        sFull.rememberCommittedAudio(2, committed, t0);

        byte[] carry = sFull.takeMergeableCommittedAudio(3, t0 + 500L);
        assertNotNull(carry, "no output yet, inside the window: merge");
        sFull.resetForSpeechStart(3, carry);
        sFull.appendMicPcm(3, 0, pcm(40_000, 3)); // "what is the difference between make and do?"
        byte[] merged = sFull.takeAndClearPcm();
        assertEquals(68_000, merged.length);
        assertEquals(2, merged[0]);
        assertEquals(3, merged[merged.length - 1]);
        assertNull(sFull.takeMergeableCommittedAudio(4, t0 + 600L), "audio is carried once");

        // 2. Pause < 480 ms (e.g. 80 ms): (480 - 80) * 32 = 12,800 B overlapping preroll trimmed across 1,920 B frames!
        var sSeam = state();
        sSeam.resetForSpeechStart(2);
        sSeam.appendMicPcm(2, 0, pcm(20_000, 2));
        sSeam.beginResponse(2);
        sSeam.rememberCommittedAudio(2, sSeam.takeAndClearPcm(), t0);

        byte[] seamCarry = sSeam.takeMergeableCommittedAudio(3, t0 + 80L);
        assertNotNull(seamCarry);
        sSeam.resetForSpeechStart(3, seamCarry);
        // Stream 10 frames of 1,920 B (= 19,200 B total): first 12,800 B trimmed, remaining 6,400 B appended cleanly
        for (int f = 0; f < 10; f++) {
            sSeam.appendMicPcm(3, (long) f * 960L, pcm(1_920, f < 6 ? 9 : 5));
        }
        byte[] seamMerged = sSeam.takeAndClearPcm();
        assertEquals(20_000 + (19_200 - 12_800), seamMerged.length);
        assertEquals(2, seamMerged[19_999]);
        assertEquals(5, seamMerged[seamMerged.length - 1]);

        // 3. 20.0s (640,000 B) turn buffer & 15.0s (480,000 B) carry cap
        assertEquals(640_000, EchoVoiceWebSocketHandler.MAX_TURN_PCM_BYTES);
        assertEquals(480_000, EchoVoiceWebSocketHandler.MAX_TURN_CARRY_BYTES);
        var sCap = state();
        sCap.resetForSpeechStart(5, pcm(520_000, 4));
        assertEquals(480_000, sCap.currentPcmLengthForTurn(5));
    }

    @Test
    void aTurnThatAlreadyProducedOutputOrWasCancelledOrIsOldIsNeverMerged() {
        long now = System.currentTimeMillis();

        var spoke = state();
        spoke.beginResponse(2);
        spoke.rememberCommittedAudio(2, pcm(8_000, 2), now);
        spoke.markOutputStarted(2); // first words / audio / card / guard / action / plan already reached the learner
        assertNull(spoke.takeMergeableCommittedAudio(3, now));

        var cancelled = state();
        cancelled.beginResponse(2);
        cancelled.rememberCommittedAudio(2, pcm(8_000, 2), now);
        cancelled.cancelActiveTurn();
        assertNull(cancelled.takeMergeableCommittedAudio(3, now));

        var old = state();
        old.beginResponse(2);
        old.rememberCommittedAudio(2, pcm(8_000, 2), now);
        assertNull(old.takeMergeableCommittedAudio(3, now + EchoVoiceWebSocketHandler.TURN_MERGE_WINDOW_MS + 50));

        var notNewer = state();
        notNewer.beginResponse(5);
        notNewer.rememberCommittedAudio(5, pcm(8_000, 5), now);
        assertNull(notNewer.takeMergeableCommittedAudio(5, now), "only a newer turn may absorb it");
    }

    @Test
    void bareVocativeHoldNeverCallsStreamVoiceTurnOrCreatesSessionAndMergesWithin2400ms() throws Exception {
        assertTrue(EchoVoiceWebSocketHandler.isBareVocative("Hi Echo,"));
        assertTrue(EchoVoiceWebSocketHandler.isBareVocative("High echo."));
        assertTrue(EchoVoiceWebSocketHandler.isBareVocative("Hey Echo Jarvis!"));
        assertTrue(EchoVoiceWebSocketHandler.isBareVocative("Echo ơi,"));
        assertTrue(EchoVoiceWebSocketHandler.isBareVocative("Này Echo"));
        assertFalse(EchoVoiceWebSocketHandler.isBareVocative("High Echo, open speaking"));
        assertFalse(EchoVoiceWebSocketHandler.isBareVocative("Hello"));

        var s = state();
        long t0 = 2_000_000L;
        s.beginResponse(2);
        s.rememberCommittedAudio(2, pcm(24_000, 7), t0);
        s.holdBareVocativeForMerge(2, EchoVoiceWebSocketHandler.VOCATIVE_MERGE_WINDOW_MS);
        // At +2,100 ms (> 1,600 ms normal window, <= 2,400 ms vocative window), carry STILL merges!
        assertNotNull(s.takeMergeableCommittedAudio(3, t0 + 2_100L));

        // End-to-end WS verification: bare "High echo," commits -> 0 streamVoiceTurn, 0 createSession, emits listening
        AiChatService chat = mock(AiChatService.class);
        EchoCoachService coach = mock(EchoCoachService.class);
        SpeakingTtsService tts = mock(SpeakingTtsService.class);
        RestTemplate asr = mock(RestTemplate.class);
        RestTemplate turnCheck = mock(RestTemplate.class);
        AuthSessionService sessions = mock(AuthSessionService.class);
        UserRepository users = mock(UserRepository.class);

        UUID sid = UUID.randomUUID();
        when(sessions.validateAndTouchActiveSession(sid, 55L)).thenReturn(true);
        User activeUser = new User();
        activeUser.setId(55L);
        activeUser.setAccountStatus("ACTIVE");
        when(users.findById(55L)).thenReturn(Optional.of(activeUser));

        when(asr.postForObject(anyString(), any(HttpEntity.class), eq(Transcript.class), anyString(), eq("final")))
                .thenReturn(new Transcript("High echo,", "High echo,", false, "en", 0.05, -0.25, 1.1, null));

        EchoVoiceWebSocketHandler handler = new EchoVoiceWebSocketHandler(
                chat, mock(EchoLearnerBrain.class), coach, mock(EchoConfirmations.class),
                tts, new ObjectMapper(), asr, turnCheck, sessions, users);

        CountDownLatch listeningAfterVocative = new CountDownLatch(1);
        List<String> frames = new CopyOnWriteArrayList<>();
        WebSocketSession ws = mockWsSession("ws-voc-55", 55L, sid, frames, payload -> {
            if (payload.contains("\"reason\":\"merged\"") && payload.contains("\"turnSeq\":2")) {
                listeningAfterVocative.countDown();
            }
        });

        try {
            handler.afterConnectionEstablished(ws);
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.speech_started\",\"turnSeq\":2}"));
            byte[] uplink = new byte[7 + 6400];
            uplink[0] = 0x01;
            uplink[1] = 0x00;
            uplink[2] = 0x02;
            handler.handleBinaryMessage(ws, new BinaryMessage(uplink));
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":2}"));

            assertTrue(listeningAfterVocative.await(3, TimeUnit.SECONDS));
            verify(chat, never()).streamVoiceTurn(anyLong(), any(), any());
            verify(coach, never()).createSession(anyLong(), any());
        } finally {
            handler.afterConnectionClosed(ws, CloseStatus.NORMAL);
            handler.shutdown();
        }
    }

    @Test
    void highEchoFastPathParityCompilesToPlaneANavigateAndPreservesNegationShield() {
        var en = EchoVoiceFastPathMatcher.evaluate("High Echo, open speaking", "/dashboard", false);
        assertNull(en.guard());
        assertNotNull(en.plan(), "Whisper 'High Echo, open speaking' must hit Plane-A fast-path");
        assertEquals("/speaking", en.plan().intents().get(0).get("href"));

        var politeQ = EchoVoiceFastPathMatcher.evaluate("High Echo, can you open speaking?", "/dashboard", false);
        assertNotNull(politeQ.plan());
        assertEquals("/speaking", politeQ.plan().intents().get(0).get("href"));

        var vi = EchoVoiceFastPathMatcher.evaluate("High echo, mở phần luyện nói", "/dashboard", false);
        assertNotNull(vi.plan());
        assertEquals("/speaking", vi.plan().intents().get(0).get("href"));

        var negated = EchoVoiceFastPathMatcher.evaluate("High Echo, don't open speaking", "/dashboard", false);
        assertNull(negated.guard());
        assertNull(negated.plan(), "Negated 'High Echo, don't open speaking' must delegate to Plane B");
    }

    @Test
    void dictionaryQueryExtractionStripsLeadingLabelsAndTrailingDictionaryOrPolitenessTailsWhilePreservingIdioms() {
        Map<String, String> expectedHeadwords = new java.util.LinkedHashMap<>();
        expectedHeadwords.put("Look up the word meticulous in the dictionary for me", "meticulous");
        expectedHeadwords.put("Look up vocabulary ephemeral from my English dictionary please", "ephemeral");
        expectedHeadwords.put("Define the term ubiquitous in the dictionary right now", "ubiquitous");
        expectedHeadwords.put("Look up \"meticulous\" in the dictionary for me", "meticulous");
        expectedHeadwords.put("Look up break the ice in the dictionary", "break the ice");
        expectedHeadwords.put("Look up the idiom break the ice in the dictionary for me", "break the ice");
        expectedHeadwords.put("Look up bread and butter in the dictionary", "bread and butter");
        expectedHeadwords.put("Tra từ resilient trong từ điển giúp mình", "resilient");
        expectedHeadwords.put("Tra từ vựng meticulous ở từ điển cho mình nhé", "meticulous");
        expectedHeadwords.put("Tra cứu nghĩa của từ serendipity bằng từ điển đi", "serendipity");
        expectedHeadwords.put("Tra từ \"resilient\" trong từ điển giúp mình", "resilient");

        for (var entry : expectedHeadwords.entrySet()) {
            var out = EchoVoiceFastPathMatcher.evaluate(entry.getKey(), "/dashboard", false);
            assertNull(out.guard(), "Unexpected guard for: " + entry.getKey());
            assertNotNull(out.plan(), "Expected Plane-A dictionary match for: " + entry.getKey());
            assertEquals("dictionary_lookup", out.plan().intents().get(0).get("kind"));
            assertEquals(entry.getValue(), out.plan().intents().get(0).get("word"),
                    "Extracted dictionary headword mismatch for: " + entry.getKey());
        }

        var bareOpen = EchoVoiceFastPathMatcher.evaluate("Open the dictionary", "/dashboard", false);
        assertNotNull(bareOpen.plan());
        assertEquals("dictionary_lookup", bareOpen.plan().intents().get(0).get("kind"));
        assertEquals("", bareOpen.plan().intents().get(0).get("word"));
    }

    @Test
    void tailSilenceHighConfidencePartialPromotesToFinalWithoutSecondAsrCallAndPassesSessionTurnParams() throws Exception {
        AiChatService chat = mock(AiChatService.class);
        EchoCoachService coach = mock(EchoCoachService.class);
        SpeakingTtsService tts = mock(SpeakingTtsService.class);
        RestTemplate asr = mock(RestTemplate.class);
        RestTemplate turnCheck = mock(RestTemplate.class);
        AuthSessionService sessions = mock(AuthSessionService.class);
        UserRepository users = mock(UserRepository.class);

        UUID sid = UUID.randomUUID();
        when(sessions.validateAndTouchActiveSession(sid, 66L)).thenReturn(true);
        User activeUser = new User();
        activeUser.setId(66L);
        activeUser.setAccountStatus("ACTIVE");
        when(users.findById(66L)).thenReturn(Optional.of(activeUser));

        List<String> calledUrls = new CopyOnWriteArrayList<>();
        CountDownLatch partialDecoded = new CountDownLatch(1);
        when(asr.postForObject(anyString(), any(HttpEntity.class), eq(Transcript.class), anyString(), eq("partial")))
                .thenAnswer(inv -> {
                    calledUrls.add(inv.getArgument(0));
                    partialDecoded.countDown();
                    return new Transcript(
                            "Explain skimming briefly",
                            "Explain skimming",
                            false,
                            "en",
                            0.04,
                            -0.22,
                            1.15,
                            null);
                });

        CountDownLatch responseDone = new CountDownLatch(1);
        when(chat.streamVoiceTurn(eq(66L), any(), any())).thenAnswer(inv -> {
            AiChatService.VoiceStreamCallbacks cb = inv.getArgument(2);
            cb.onDelta("Skimming catches the main gist quickly.");
            cb.onComplete(new AiChatResponse("Skimming catches the main gist quickly.", "fast", "FAST", List.of(), List.of()));
            return (Runnable) () -> {};
        });

        EchoVoiceWebSocketHandler handler = new EchoVoiceWebSocketHandler(
                chat, mock(EchoLearnerBrain.class), coach, mock(EchoConfirmations.class),
                tts, new ObjectMapper(), asr, turnCheck, sessions, users);

        List<String> frames = new CopyOnWriteArrayList<>();
        WebSocketSession ws = mockWsSession("ws-fast-66", 66L, sid, frames, payload -> {
            if (payload.contains("\"response.done\"")) responseDone.countDown();
        });

        try {
            handler.afterConnectionEstablished(ws);
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.speech_started\",\"turnSeq\":4}"));
            // Send 24,000 B voiced audio (>= 0.75s triggers partial ASR)
            byte[] voicedFrame = new byte[7 + 24_000];
            voicedFrame[0] = 0x01;
            voicedFrame[1] = 0x00;
            voicedFrame[2] = 0x04;
            for (int i = 7; i < voicedFrame.length; i += 2) {
                voicedFrame[i] = 0x40;
                voicedFrame[i + 1] = 0x08; // ~2112 int16 amplitude (voiced speech)
            }
            handler.handleBinaryMessage(ws, new BinaryMessage(voicedFrame));
            assertTrue(partialDecoded.await(3, TimeUnit.SECONDS));

            // Append 6,400 B (200 ms) of pure endpoint silence (< -42 dBFS) and commit
            byte[] silentTail = new byte[7 + 6_400];
            silentTail[0] = 0x01;
            silentTail[1] = 0x00;
            silentTail[2] = 0x04;
            handler.handleBinaryMessage(ws, new BinaryMessage(silentTail));
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":4}"));

            assertTrue(responseDone.await(3, TimeUnit.SECONDS));
            assertFalse(calledUrls.isEmpty());
            assertTrue(calledUrls.get(0).contains("session_id=ws-fast-66"));
            assertTrue(calledUrls.get(0).contains("turn_seq=4"));
            // High-confidence tail-silence partial promoted directly -> ZERO mode="final" GPU calls!
            verify(asr, never()).postForObject(anyString(), any(HttpEntity.class), eq(Transcript.class), anyString(), eq("final"));
            assertTrue(frames.stream().anyMatch(f -> f.contains("\"asr.partial\"") && f.contains("\"stableText\":\"Explain skimming\"")));
            assertTrue(frames.stream().anyMatch(f -> f.contains("\"asr.final\"") && f.contains("Explain skimming briefly")));
        } finally {
            handler.afterConnectionClosed(ws, CloseStatus.NORMAL);
            handler.shutdown();
        }
    }

    @Test
    void supersededAttachCancelHandleInvokesHandleImmediatelyAndExplicitBlankTruncateNeverFabricatesRatioWords() {
        var s = state();
        s.beginResponse(2);
        s.beginResponse(3); // Turn 3 already superseded Turn 2 before Turn 2's streamVoiceTurn returned!
        AtomicBoolean turn2HandleCancelled = new AtomicBoolean(false);
        s.attachCancelHandle(2, () -> turn2HandleCancelled.set(true));
        assertTrue(turn2HandleCancelled.get(), "Superseded turn's cancelHandle must run immediately to release quota/stream");

        // Explicit spokenText="" at 400ms playedMs must NEVER fabricate words via playedMs/duration ratio
        var truncState = state();
        truncState.recordTurnUserText(5, "Explain conditionals");
        truncState.recordGeneratedAssistantText(5, "Conditionals describe the result of a certain condition.");
        truncState.recordGeneratedSamples(5, 48_000L); // 2.0s audio
        String heardExplicitZero = truncState.truncateInMemoryHistory(5, "", 400L);
        assertEquals("", heardExplicitZero, "Explicit empty spokenText must never fabricate unheard words via ratio");

        // Legacy null spokenText still falls back to playedMs ratio
        String heardLegacyRatio = truncState.truncateInMemoryHistory(5, null, 600L);
        assertNotNull(heardLegacyRatio);
        assertFalse(heardLegacyRatio.isBlank());
    }

    @Test
    void spokenProseSanitizerStripsSingleItalicsEmojisIpaSlashesAndCefrLabelsAndChunkerUsesSubSecondClause0() {
        List<String> slices = EchoVoiceWebSocketHandler.sanitizeAndSliceClauseForSpeech(
                "Pronunciation: /r\u026A\u02C8z\u026Ali\u0259nt/ CEFR: B1 \u2013 B2. \uD83D\uDC49 *Resilient* means bouncing back fast \uD83D\uDE0A✨! Compare make/do on 9/10.");
        assertEquals(1, slices.size());
        String spoken = slices.get(0);
        assertFalse(spoken.contains("*"), "Single-asterisk italics must be stripped: " + spoken);
        assertFalse(spoken.contains("/r\u026A"), "Slash IPA must be stripped: " + spoken);
        assertFalse(spoken.contains("CEFR:"), "CEFR metadata label must be stripped: " + spoken);
        assertFalse(spoken.contains("\uD83D\uDC49") || spoken.contains("\uD83D\uDE0A") || spoken.contains("✨"),
                "Emojis must be stripped: " + spoken);
        assertTrue(spoken.contains("Resilient means bouncing back fast!"), "Spoken prose preserved: " + spoken);
        assertTrue(spoken.contains("make/do") && spoken.contains("9/10"), "Ordinary slashes/fractions preserved: " + spoken);

        List<String> clauses = new ArrayList<>();
        var chunker = new EchoVoiceWebSocketHandler.FirstClauseChunker(clauses::add);
        chunker.accept("Sure, let's check! Here is a clear example for your daily speaking practice.");
        assertFalse(clauses.isEmpty(), "Clause 0 must split at <= 32 chars / >= 8 punct without waiting for 42 chars");
        assertEquals("Sure, let's check!", clauses.get(0));
    }

    private static WebSocketSession mockWsSession(
            String id,
            long userId,
            UUID authSid,
            List<String> textOut,
            java.util.function.Consumer<String> onText) throws Exception {
        Map<String, Object> attrs = new HashMap<>();
        attrs.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, userId);
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                new UserDetailsImpl(userId, "u" + userId + "@example.com", "pw", List.of()), null, List.of());
        auth.setDetails(new AuthSessionContext(authSid, userId, "CREDENTIALS", Instant.now(), null, null, null));
        attrs.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, auth);

        WebSocketSession ws = mock(WebSocketSession.class);
        when(ws.getId()).thenReturn(id);
        when(ws.getAttributes()).thenReturn(attrs);
        when(ws.isOpen()).thenReturn(true);
        doAnswer(inv -> {
            WebSocketMessage<?> m = inv.getArgument(0);
            if (m instanceof TextMessage tm) {
                textOut.add(tm.getPayload());
                onText.accept(tm.getPayload());
            }
            return null;
        }).when(ws).sendMessage(any(WebSocketMessage.class));
        return ws;
    }
}
