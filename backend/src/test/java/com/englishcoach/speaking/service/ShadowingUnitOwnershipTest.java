package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.speaking.config.SpeakingShadowingSchemaRepair;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Security release V3 finding: the IPA and translation of a shadowing unit were served by unit id alone, so any
 * signed-in learner could read (in translation) the sentences of another learner's private listening material by
 * counting unit ids. A unit is now served only to a caller who may see its material.
 */
class ShadowingUnitOwnershipTest {

    private static final long OWNER = 7L, STRANGER = 8L;
    private static final long PRIVATE_UNIT = 501L, SYSTEM_UNIT = 502L;

    private SpeakingShadowingUnitRepository units;
    private ListeningMaterialRepository materials;
    private SpeakingShadowingUnitService service;

    @BeforeEach
    void setUp() {
        units = mock(SpeakingShadowingUnitRepository.class);
        materials = mock(ListeningMaterialRepository.class);
        service = new SpeakingShadowingUnitService(units, materials, mock(TranscriptSegmentRepository.class),
                mock(SpeakingShadowingAttemptRepository.class), mock(CanonicalTranscriptReconstructor.class),
                mock(SpeakingShadowingSchemaRepair.class));

        ListeningMaterial privateMaterial = mock(ListeningMaterial.class);
        when(privateMaterial.getId()).thenReturn(31L);
        ListeningMaterial systemMaterial = mock(ListeningMaterial.class);
        when(systemMaterial.getId()).thenReturn(32L);
        // the repository's own visibility rule: the owner's private row, or SYSTEM content for anybody signed in
        when(materials.findByIdAndVisibleToUser(31L, OWNER)).thenReturn(Optional.of(privateMaterial));
        when(materials.findByIdAndVisibleToUser(31L, STRANGER)).thenReturn(Optional.empty());
        when(materials.findByIdAndVisibleToUser(32L, OWNER)).thenReturn(Optional.of(systemMaterial));
        when(materials.findByIdAndVisibleToUser(32L, STRANGER)).thenReturn(Optional.of(systemMaterial));

        SpeakingShadowingUnit privateUnit = unit(PRIVATE_UNIT, privateMaterial);
        SpeakingShadowingUnit systemUnit = unit(SYSTEM_UNIT, systemMaterial);
        when(units.findById(PRIVATE_UNIT)).thenReturn(Optional.of(privateUnit));
        when(units.findById(SYSTEM_UNIT)).thenReturn(Optional.of(systemUnit));
        when(units.findById(999L)).thenReturn(Optional.empty());
    }

    private static SpeakingShadowingUnit unit(long id, ListeningMaterial material) {
        SpeakingShadowingUnit unit = mock(SpeakingShadowingUnit.class);
        when(unit.getId()).thenReturn(id);
        when(unit.getMaterial()).thenReturn(material);
        when(unit.getDisplayText()).thenReturn("A private sentence of the owner.");
        when(unit.getIpa()).thenReturn("/ə ˈpraɪvət ˈsɛntəns/");
        when(unit.getTranslation()).thenReturn("Một câu riêng tư của chủ sở hữu.");
        return unit;
    }

    private static void assertNotFound(org.assertj.core.api.ThrowableAssert.ThrowingCallable call) {
        assertThatThrownBy(call).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    @DisplayName("The owner reads the IPA and translation of a unit of their own private material")
    void ownerReadsOwnUnit() {
        assertThat(service.getOrGenerateUnitIpa(PRIVATE_UNIT, OWNER).ipa()).contains("praɪvət");
        assertThat(service.getOrGenerateUnitTranslation(PRIVATE_UNIT, OWNER).translation()).contains("riêng tư");
    }

    @Test
    @DisplayName("Another learner gets 404 for that unit, the same answer as for a unit that does not exist; nothing is generated or saved")
    void strangerGetsNotFound() {
        assertNotFound(() -> service.getOrGenerateUnitIpa(PRIVATE_UNIT, STRANGER));
        assertNotFound(() -> service.getOrGenerateUnitTranslation(PRIVATE_UNIT, STRANGER));
        assertNotFound(() -> service.getOrGenerateUnitIpa(999L, STRANGER));
        assertNotFound(() -> service.getOrGenerateUnitTranslation(999L, STRANGER));
        // no caller identity at all is never enough
        assertNotFound(() -> service.getOrGenerateUnitIpa(PRIVATE_UNIT, null));
        assertNotFound(() -> service.getOrGenerateUnitTranslation(PRIVATE_UNIT, null));
        verify(units, never()).saveAndFlush(any());
    }

    @Test
    @DisplayName("Units of SYSTEM material stay readable by every signed-in learner")
    void systemUnitsStayShared() {
        assertThat(service.getOrGenerateUnitIpa(SYSTEM_UNIT, STRANGER).ipa()).isNotBlank();
        assertThat(service.getOrGenerateUnitTranslation(SYSTEM_UNIT, OWNER).translation()).isNotBlank();
    }
}
