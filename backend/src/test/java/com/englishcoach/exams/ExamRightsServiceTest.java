package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.ExamRightsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.*;

/** Regression coverage for the former rights fail-open path. */
@ExtendWith(MockitoExtension.class)
class ExamRightsServiceTest {

    @Mock
    private ExamContentRepository contentRepository;

    @Mock
    private ExamMediaRepository mediaRepository;

    private final com.englishcoach.exams.config.ExamsProperties examsProperties = new com.englishcoach.exams.config.ExamsProperties();

    @Test
    void deniesFormWithMissingProvenanceBeforeDatabaseClosureCheck() {
        UUID formId = UUID.randomUUID();
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form(formId, null)));

        assertFalse(new ExamRightsService(contentRepository, mediaRepository, examsProperties).verifyFormRights(formId));
        verify(contentRepository, never()).hasValidRightsForForm(any(), any(), anyBoolean());
    }

    @Test
    void delegatesCompleteFormClosureAndFailsClosedWhenRightsAreInvalid() {
        UUID formId = UUID.randomUUID();
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form(formId, UUID.randomUUID())));
        when(contentRepository.hasValidRightsForForm(eq(formId), any(), anyBoolean())).thenReturn(false);

        assertFalse(new ExamRightsService(contentRepository, mediaRepository, examsProperties).verifyFormRights(formId));
        verify(contentRepository).hasValidRightsForForm(eq(formId), any(), anyBoolean());
    }

    @Test
    void deniesUnvalidatedAssetBeforeRightsQuery() {
        UUID assetId = UUID.randomUUID();
        when(mediaRepository.findAssetById(assetId)).thenReturn(Optional.of(new AssetRecord(
                assetId, UUID.randomUUID(), "asset.wav", "v1", "a".repeat(64), "audio/wav", 100L,
                1000, null, "PENDING", Instant.now())));

        assertFalse(new ExamRightsService(contentRepository, mediaRepository, examsProperties)
                .isAssetAccessible(assetId, MediaPurpose.PRACTICE_AUDIO));
        verify(contentRepository, never()).hasValidRightsForAsset(any(), any(), anyBoolean());
    }

    @Test
    void evaluatesLocalPrivatePolicyCorrectly() {
        UUID formId = UUID.randomUUID();
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form(formId, UUID.randomUUID())));
        when(contentRepository.hasValidRightsForForm(eq(formId), any(), eq(true))).thenReturn(true);

        examsProperties.setRuntimePolicy(com.englishcoach.exams.config.ExamsProperties.ExamRuntimePolicy.LOCAL_PRIVATE);
        examsProperties.setStrictMode(false);

        ExamRightsService service = new ExamRightsService(contentRepository, mediaRepository, examsProperties);
        assertTrue(service.isLocalPrivatePolicyActive());
        assertTrue(service.verifyFormRights(formId));
        verify(contentRepository).hasValidRightsForForm(eq(formId), any(), eq(true));
    }

    @Test
    void evaluatesPublicProductionPolicyStrictFailClosed() {
        UUID formId = UUID.randomUUID();
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form(formId, UUID.randomUUID())));
        when(contentRepository.hasValidRightsForForm(eq(formId), any(), eq(false))).thenReturn(false);

        examsProperties.setRuntimePolicy(com.englishcoach.exams.config.ExamsProperties.ExamRuntimePolicy.PUBLIC_PRODUCTION);

        ExamRightsService service = new ExamRightsService(contentRepository, mediaRepository, examsProperties);
        assertFalse(service.isLocalPrivatePolicyActive());
        assertFalse(service.verifyFormRights(formId));
        verify(contentRepository).hasValidRightsForForm(eq(formId), any(), eq(false));
    }

    private FormVersionRecord form(UUID id, UUID provenanceId) {
        return new FormVersionRecord(id, "rights-test", 1, "Rights test", ExamFamily.IELTS, "ACADEMIC",
                "READING", UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), LifecycleState.DRAFT,
                provenanceId, 1L, "a".repeat(64), null, null, Instant.now());
    }
}
