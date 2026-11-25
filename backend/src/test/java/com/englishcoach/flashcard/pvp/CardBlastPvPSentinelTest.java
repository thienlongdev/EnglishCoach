package com.englishcoach.flashcard.pvp;

import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.CreateRoomRequest;
import com.englishcoach.flashcard.pvp.model.*;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.flashcard.repository.*;
import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import java.time.Clock;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/** Echo Sentinel on Card Blast 1v1 (10 §BX): a void during the match is a forfeit; no acknowledgement, no ranking. */
class CardBlastPvPSentinelTest {
    static final class NullStore extends SentinelStore {
        NullStore() { super(null); }
        @Override public void write(SentinelAttempt.Change c) { }
        @Override public void writeLater(SentinelAttempt.Change c) { }
    }
    SentinelService sentinel = new SentinelService(new NullStore(), Clock.systemUTC());
    @AfterEach void close() { sentinel.close(); }
    SentinelService.Begun begin(long user, String activity) { return sentinel.begin(user, activity, true, SentinelPolicy.POLICY_VERSION); }
    static String h(SentinelService.Begun b) { return b.id() + "." + b.token(); }

    CardBlastPvPService pvp() {
        var cards = mock(FlashcardRepository.class);
        var entries = new ArrayList<com.englishcoach.dictionary.entity.DictionaryEntry>();
        for (int i = 0; i < 12; i++) { var e = new com.englishcoach.dictionary.entity.DictionaryEntry(); e.setId(101L + i); e.setWord("word" + i);
            e.setGeneralTranslationVi("nghĩa" + i); e.setMeanings(List.of("nghĩa" + i)); entries.add(e); }
        when(cards.findPvPPersonalWords(anyLong())).thenReturn(PvPWordFixtures.rows(entries));
        when(cards.findPvPWordsByDeckId(anyLong())).thenReturn(PvPWordFixtures.rows(entries));
        var s = new CardBlastPvPService(mock(SimpMessagingTemplate.class), cards, mock(DictionaryRepository.class), mock(VocabDeckRepository.class));
        ReflectionTestUtils.invokeMethod(s, "setSentinel", sentinel);
        return s;
    }

    @Test void pvpVoidIsAForfeitAndTheHonestPlayerCompletesVerified() {
        var s = pvp();
        CardBlastRoom room = s.createRoom("11", "A", null, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build());
        s.joinRoom("12", "B", null, room.getRoomCode());
        var a = begin(11, SentinelPolicy.CARD_BLAST_PVP); var b = begin(12, SentinelPolicy.CARD_BLAST_PVP);
        s.setReady("11", room.getRoomCode(), true, null, h(a));
        s.setReady("12", room.getRoomCode(), true, null, h(b));
        assertEquals(RoomStatus.COUNTDOWN, room.getStatus());
        assertNotNull(room.getHost().getSentinel()); assertNotNull(room.getGuest().getSentinel());
        sentinel.heartbeat(12, b.id(), b.token(), true);
        sentinel.violation(11, a.id(), a.token(), "HIDDEN");
        assertEquals(RoomStatus.FINISHED, room.getStatus());
        assertEquals("FORFEIT", room.getEndReason());
        assertEquals(SentinelAttempt.State.VOIDED_FOCUS_LOSS, room.getHost().getSentinel().state());
        assertEquals(SentinelAttempt.State.COMPLETED_VERIFIED, room.getGuest().getSentinel().state());
    }

    @Test void pvpWithoutAcknowledgementIsNeverRanked() {
        var s = pvp();
        CardBlastRoom room = s.createRoom("21", "A", null, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build());
        s.joinRoom("22", "B", null, room.getRoomCode());
        var a = begin(21, SentinelPolicy.CARD_BLAST_PVP);
        s.setReady("21", room.getRoomCode(), true, null, h(a));
        s.setReady("22", room.getRoomCode(), true, null, null);
        Boolean ranked = ReflectionTestUtils.invokeMethod(s, "sentinelAllowsRanking", room, "KO", "22");
        assertEquals(Boolean.FALSE, ranked);
    }

}
