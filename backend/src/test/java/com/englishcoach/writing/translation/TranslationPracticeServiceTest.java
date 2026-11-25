package com.englishcoach.writing.translation;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.translation.dto.*;
import com.englishcoach.writing.translation.entity.*;
import com.englishcoach.writing.translation.repository.*;
import com.englishcoach.writing.translation.service.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class TranslationPracticeServiceTest {

    private TranslationDeterministicGrader deterministicGrader;

    @Mock
    private TranslationGradeCacheRepository gradeCacheRepository;

    private TranslationGradeCacheService gradeCacheService;

    @BeforeEach
    void setUp() {
        deterministicGrader = new TranslationDeterministicGrader();
        gradeCacheService = new TranslationGradeCacheService(gradeCacheRepository);
    }

    @Test
    void testDeterministicExactMatch_AcceptsImmediately() {
        String submitted = "Students need to read books every day to expand their vocabulary.";
        String reference = "Students need to read books every day to expand their vocabulary.";

        Optional<TranslationFeedbackDto> result = deterministicGrader.evaluateExact(submitted, reference, "[]");

        assertTrue(result.isPresent());
        assertEquals("ACCEPTED", result.get().getOverallStatus());
        assertEquals("ACCURATE", result.get().getMeaningVerdict());
        assertEquals("NATURAL", result.get().getNaturalnessVerdict());
    }

    @Test
    void testDeterministicVariantMatch_Accepts() {
        String submitted = "Pupils should read books daily to broaden vocabulary.";
        String reference = "Students need to read books every day to expand their vocabulary.";
        String variantsJson = "[\"Pupils should read books daily to broaden vocabulary.\"]";

        Optional<TranslationFeedbackDto> result = deterministicGrader.evaluateExact(submitted, reference, variantsJson);

        assertTrue(result.isPresent());
        assertEquals("ACCEPTED", result.get().getOverallStatus());
    }

    @Test
    void testDeterministicNonMatch_ReturnsEmpty() {
        String submitted = "They read books.";
        String reference = "Students need to read books every day to expand their vocabulary.";

        Optional<TranslationFeedbackDto> result = deterministicGrader.evaluateExact(submitted, reference, "[]");

        assertFalse(result.isPresent());
    }

    @Test
    void testGradeCacheFingerprint_Deterministic() {
        UUID exId = UUID.randomUUID();
        UUID unitId = UUID.randomUUID();
        String fp1 = gradeCacheService.computeFingerprint(1L, exId, unitId, 1, "hash123", "v1.0");
        String fp2 = gradeCacheService.computeFingerprint(1L, exId, unitId, 1, "hash123", "v1.0");
        String fpDiff = gradeCacheService.computeFingerprint(2L, exId, unitId, 1, "hash123", "v1.0");

        assertEquals(fp1, fp2);
        assertNotEquals(fp1, fpDiff);
    }

    @Test
    void testL1CacheHit_ReturnsCachedFeedback() {
        Long userId = 100L;
        UUID exId = UUID.randomUUID();
        UUID unitId = UUID.randomUUID();
        String fp = gradeCacheService.computeFingerprint(userId, exId, unitId, 1, "hashABC", "v1.0");

        TranslationFeedbackDto feedback = TranslationFeedbackDto.builder()
                .meaningVerdict("ACCURATE")
                .grammarVerdict("ACCURATE")
                .naturalnessVerdict("NATURAL")
                .overallStatus("ACCEPTED")
                .headlineSummary("Tuyệt vời!")
                .issues(Collections.emptyList())
                .build();

        gradeCacheService.putResult(userId, fp, exId, unitId, 1, "hashABC", "v1.0", feedback, UUID.randomUUID());

        Optional<TranslationFeedbackDto> cached = gradeCacheService.getCachedResult(userId, fp);
        assertTrue(cached.isPresent());
        assertEquals("Tuyệt vời!", cached.get().getHeadlineSummary());
    }

    @Test
    void testTokenizeReference_InitialMaskingAndReveal() {
        String reference = "Students need to read books every day to expand their vocabulary.";
        Set<Integer> revealed = new HashSet<>();

        List<TranslationTokenDto> tokens = TranslationSessionService.tokenizeReference(reference, revealed, false);
        assertEquals(11, tokens.size());

        // First token "Students"
        TranslationTokenDto firstToken = tokens.get(0);
        assertEquals(0, firstToken.getIndex());
        assertEquals("S", firstToken.getFirstChar());
        assertEquals(8, firstToken.getLength());
        assertFalse(firstToken.isRevealed());
        assertEquals("Students", firstToken.getWord()); // Available for zero-network local toggle

        // Last token "vocabulary."
        TranslationTokenDto lastToken = tokens.get(10);
        assertEquals("v", lastToken.getFirstChar());
        assertEquals(10, lastToken.getLength());
        assertEquals(".", lastToken.getTrailingPunct());
        assertFalse(lastToken.isRevealed());
        assertEquals("vocabulary", lastToken.getWord());

        // Reveal token 0
        revealed.add(0);
        List<TranslationTokenDto> updatedTokens = TranslationSessionService.tokenizeReference(reference, revealed, false);
        assertTrue(updatedTokens.get(0).isRevealed());
        assertEquals("Students", updatedTokens.get(0).getWord());
        assertFalse(updatedTokens.get(1).isRevealed());
    }

    @Test
    void testExactMatchCaseInsensitive_Accepts() {
        String submitted = "students need to read books every day to expand their vocabulary.";
        String reference = "Students need to read books every day to expand their vocabulary.";

        Optional<TranslationFeedbackDto> result = deterministicGrader.evaluateExact(submitted, reference, "[]");
        assertTrue(result.isPresent());
        assertEquals("ACCEPTED", result.get().getOverallStatus());
    }

    @Test
    void testExactMatchPunctuationInsensitive_Accepts() {
        // Without period vs with period
        String submitted = "students need to read books every day to expand their vocabulary";
        String reference = "Students need to read books every day to expand their vocabulary.";

        Optional<TranslationFeedbackDto> result = deterministicGrader.evaluateExact(submitted, reference, "[]");
        assertTrue(result.isPresent());
        assertEquals("ACCEPTED", result.get().getOverallStatus());
    }

    @Test
    void testExactMatchSmartQuotes_Accepts() {
        // Smart apostrophe ’ vs straight ' and exclamation ! vs period .
        String submitted = "education plays a crucial role in developing young people’s critical thinking!";
        String reference = "Education plays a crucial role in developing young people's critical thinking.";

        Optional<TranslationFeedbackDto> result = deterministicGrader.evaluateExact(submitted, reference, "[]");
        assertTrue(result.isPresent());
        assertEquals("ACCEPTED", result.get().getOverallStatus());
    }
}
