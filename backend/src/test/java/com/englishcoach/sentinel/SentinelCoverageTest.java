package com.englishcoach.sentinel;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.flashcard.dto.CardBlastFinishRunRequest;
import com.englishcoach.flashcard.pvp.model.*;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.CreateRoomRequest;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.flashcard.repository.*;
import com.englishcoach.flashcard.service.*;
import org.junit.jupiter.api.*;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageImpl;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import java.time.Clock;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isA;
import static org.mockito.Mockito.*;

/** Echo Sentinel coverage beyond Soán ngôi (10 §BX): Card Blast solo runs and Card Blast 1v1. */
class SentinelCoverageTest {
    static final class NullStore extends SentinelStore {
        NullStore() { super(null); }
        @Override public void write(SentinelAttempt.Change c) { }
        @Override public void writeLater(SentinelAttempt.Change c) { }
        @Override public Stored stateOf(long user, String activity, String subject) { return null; }
    }
    SentinelService sentinel = new SentinelService(new NullStore(), Clock.systemUTC());
    @AfterEach void close() { sentinel.close(); }
    SentinelService.Begun begin(long user, String activity) { return sentinel.begin(user, activity, true, SentinelPolicy.POLICY_VERSION); }
    static String h(SentinelService.Begun b) { return b.id() + "." + b.token(); }

    FlashcardService solo(CardBlastRunRepository runs, ApplicationEventPublisher events) {
        var users = mock(UserRepository.class);
        when(users.findById(any())).thenAnswer(i -> Optional.of(User.builder().id(i.getArgument(0)).email("x@example.test").build()));
        var cards = mock(FlashcardRepository.class);
        when(cards.findByUserId(any(), any())).thenReturn(new PageImpl<>(List.of()));
        var s = new FlashcardService(cards, users, mock(DictionaryRepository.class), new AnkiNoteParser(), mock(VocabDeckRepository.class), null, null, null, runs);
        ReflectionTestUtils.setField(s, "eventPublisher", events);
        ReflectionTestUtils.invokeMethod(s, "setSentinel", sentinel);
        return s;
    }
    static CardBlastFinishRunRequest result(String run) { return new CardBlastFinishRunRequest(null, 10, 100.0, List.of(), 1, 1, run); }

    @Test void cardBlastSoloCountsOnlyAVerifiedRun() {
        var runs = mock(CardBlastRunRepository.class); var events = mock(ApplicationEventPublisher.class);
        var service = solo(runs, events);
        // No acknowledgement: the run plays but earns nothing.
        String plain = service.startCardBlastRun(1L, null, null).orElseThrow();
        assertFalse(service.recordCardBlastRun(1L, result(plain)));
        // Verified run counts once.
        var b = begin(2, SentinelPolicy.CARD_BLAST_SOLO);
        String ok = service.startCardBlastRun(2L, null, h(b)).orElseThrow();
        sentinel.heartbeat(2, b.id(), b.token(), true);
        assertTrue(service.recordCardBlastRun(2L, result(ok)));
        // Left the screen during the run: not counted, and the void stays.
        var v = begin(3, SentinelPolicy.CARD_BLAST_SOLO);
        String left = service.startCardBlastRun(3L, null, h(v)).orElseThrow();
        assertEquals("VOIDED_FOCUS_LOSS", sentinel.violation(3, v.id(), v.token(), "HIDDEN").state());
        assertFalse(service.recordCardBlastRun(3L, result(left)));
        // Another learner's handle binds nothing.
        var other = begin(4, SentinelPolicy.CARD_BLAST_SOLO);
        String stolen = service.startCardBlastRun(5L, null, h(other)).orElseThrow();
        assertFalse(service.recordCardBlastRun(5L, result(stolen)));
        verify(runs, times(1)).save(any());
        verify(events, times(1)).publishEvent(isA(com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent.class));
    }

    @Test void examAttemptBindsOnceAndAReopenEndsIt() {
        var b = begin(31, SentinelPolicy.EXAM_SIMULATION);
        String exam = UUID.randomUUID().toString();
        assertNotNull(sentinel.bindSubject(31, h(b), SentinelPolicy.EXAM_SIMULATION, exam));
        assertNull(sentinel.bindSubject(31, h(b), SentinelPolicy.EXAM_SIMULATION, exam), "a used handle never binds again");
        assertEquals("VOIDED_RELOAD", sentinel.reopen(31, SentinelPolicy.EXAM_SIMULATION, exam).state());
        assertNull(sentinel.completeSubject(31, SentinelPolicy.EXAM_SIMULATION, exam), "a voided exam attempt never completes");
        var c = begin(32, SentinelPolicy.EXAM_SIMULATION); String exam2 = UUID.randomUUID().toString();
        sentinel.bindSubject(32, h(c), SentinelPolicy.EXAM_SIMULATION, exam2);
        sentinel.heartbeat(32, c.id(), c.token(), true);
        assertEquals(SentinelAttempt.State.COMPLETED_VERIFIED, sentinel.completeSubject(32, SentinelPolicy.EXAM_SIMULATION, exam2).to());
        assertNull(sentinel.reopen(33, SentinelPolicy.EXAM_SIMULATION, UUID.randomUUID().toString()), "unbound subject");
    }
}
