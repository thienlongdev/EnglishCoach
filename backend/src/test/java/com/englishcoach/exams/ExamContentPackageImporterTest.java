package com.englishcoach.exams;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidationException;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.repository.ExamContentRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Import boundary tests: reject before JDBC and replay by immutable identity. */
@ExtendWith(MockitoExtension.class)
class ExamContentPackageImporterTest {

    @Mock
    private ExamContentRepository repository;

    @Mock
    private ExamContentPackageValidator validator;

    @Test
    void rejectsBeforeGraphMutationWhenValidationFails() {
        ExamContentPackage pkg = packageEnvelope("invalid-hash");
        ExamContentPackage.ValidationError error = new ExamContentPackage.ValidationError(
                "licenses[0]", "RIGHTS_NOT_APPROVED", "Rights must be approved");
        when(validator.validate(pkg)).thenReturn(ExamContentPackage.ValidationResult.invalid(
                "invalid-hash", List.of(error)));

        ExamContentPackageImporter importer = new ExamContentPackageImporter(repository, validator);

        ExamContentPackageValidationException exception = assertThrows(
                ExamContentPackageValidationException.class, () -> importer.importPackage(pkg, 7L));
        assertEquals("RIGHTS_NOT_APPROVED", exception.errors().get(0).code());
        verifyNoInteractions(repository);
    }

    @Test
    void returnsIdempotentReplayForSameVersionAndHash() {
        ExamContentPackage pkg = packageEnvelope("b".repeat(64));
        UUID formId = pkg.form().id();
        ExamContentPackage.PackageImportRecord prior = new ExamContentPackage.PackageImportRecord(
                UUID.randomUUID(), "package-replay", 1, "1.0", pkg.manifest().contentHash(), formId,
                "IMPORTED", 7L, pkg.manifest().creator(), Instant.now(), Instant.now());
        when(validator.validate(pkg)).thenReturn(ExamContentPackage.ValidationResult.valid(pkg.manifest().contentHash()));
        when(repository.findPackageImport("package-replay", 1, true)).thenReturn(Optional.of(prior));

        ExamContentPackage.ImportResult result = new ExamContentPackageImporter(repository, validator)
                .importPackage(pkg, 99L);

        assertEquals(ExamContentPackage.ImportStatus.ALREADY_IMPORTED, result.status());
        assertTrue(result.idempotentReplay());
        assertEquals(formId, result.formId());
        verify(repository).lockPackageIdentity("package-replay", 1);
        verify(repository).findPackageImport("package-replay", 1, true);
        verify(repository, never()).insertFormVersion(any());
        verify(repository, never()).insertPackageImport(any(), any(), any(), any());
    }

    @Test
    void rejectsSameVersionWithDifferentHash() {
        ExamContentPackage pkg = packageEnvelope("c".repeat(64));
        ExamContentPackage.PackageImportRecord prior = new ExamContentPackage.PackageImportRecord(
                UUID.randomUUID(), "package-replay", 1, "1.0", "d".repeat(64), pkg.form().id(),
                "IMPORTED", 7L, pkg.manifest().creator(), Instant.now(), Instant.now());
        when(validator.validate(pkg)).thenReturn(ExamContentPackage.ValidationResult.valid(pkg.manifest().contentHash()));
        when(repository.findPackageImport("package-replay", 1, true)).thenReturn(Optional.of(prior));

        IllegalStateException exception = assertThrows(IllegalStateException.class,
                () -> new ExamContentPackageImporter(repository, validator).importPackage(pkg, 99L));

        assertTrue(exception.getMessage().contains("CONTENT_PACKAGE_ID_CONFLICT"));
        verify(repository, never()).insertFormVersion(any());
    }

    private ExamContentPackage packageEnvelope(String hash) {
        UUID formId = UUID.randomUUID();
        FormVersionRecord form = new FormVersionRecord(formId, "package-replay-form", 1, "Replay form",
                ExamFamily.IELTS, "ACADEMIC", "READING", UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                LifecycleState.DRAFT, UUID.randomUUID(), 11L, hash, null, null, Instant.now());
        return new ExamContentPackage(
                new ExamContentPackage.PackageManifest("1.0", "package-replay", 1, hash, "author", 
                        "EC-EXAM-SPEC-2026-09-10", "DRAFT", Instant.now(), java.util.Map.of()),
                List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), form,
                List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(), List.of(),
                List.of(), List.of());
    }
}
