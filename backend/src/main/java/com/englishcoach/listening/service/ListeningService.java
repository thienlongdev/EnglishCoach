package com.englishcoach.listening.service;

import com.englishcoach.listening.dto.CreateListeningMaterialRequest;
import com.englishcoach.listening.dto.ListeningMaterialDetailDto;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.dto.ExerciseAttemptRequest;
import com.englishcoach.listening.dto.ExerciseAttemptResponse;
import com.englishcoach.listening.dto.ListeningExerciseDto;

import com.englishcoach.listening.dto.ListeningLibraryItemDto;

import java.util.List;

public interface ListeningService {
    List<ListeningLibraryItemDto> getSharedLibrary();

    List<com.englishcoach.listening.dto.ListeningCategoryDto> getLibraryCategories();

    List<ListeningMaterialSummaryDto> getAllMaterials(String cefrLevel, String topic, String accent, Long userId);

    List<ListeningMaterialSummaryDto> getPersonalMaterials(String cefrLevel, String topic, String accent, Long userId);

    default List<ListeningMaterialSummaryDto> getPersonalMaterials(Long userId) {
        return getPersonalMaterials(null, null, null, userId);
    }

    default List<ListeningMaterialSummaryDto> getAllMaterials(String cefrLevel, String topic, String accent) {
        return getAllMaterials(cefrLevel, topic, accent, null);
    }

    ListeningMaterialDetailDto getMaterialById(Long id, Long userId);

    default ListeningMaterialDetailDto getMaterialById(Long id) {
        return getMaterialById(id, null);
    }

    ListeningMaterialDetailDto createMaterial(CreateListeningMaterialRequest request, Long userId);

    default ListeningMaterialDetailDto createMaterial(CreateListeningMaterialRequest request) {
        return createMaterial(request, null);
    }

    List<ListeningExerciseDto> getExercisesForMaterial(Long materialId, Long userId);

    default List<ListeningExerciseDto> getExercisesForMaterial(Long materialId) {
        return getExercisesForMaterial(materialId, null);
    }

    ExerciseAttemptResponse submitExerciseAttempt(Long exerciseId, ExerciseAttemptRequest request, Long userId);

    default ExerciseAttemptResponse submitExerciseAttempt(Long exerciseId, ExerciseAttemptRequest request) {
        return submitExerciseAttempt(exerciseId, request, null);
    }
    
    ListeningMaterialDetailDto importMaterialFromYouTube(com.englishcoach.listening.dto.ImportListeningMaterialRequest request, Long userId);

    default ListeningMaterialDetailDto importMaterialFromYouTube(com.englishcoach.listening.dto.ImportListeningMaterialRequest request) {
        return importMaterialFromYouTube(request, null);
    }

    ListeningMaterialDetailDto importSystemMaterial(com.englishcoach.listening.dto.ImportListeningMaterialRequest request);

    /** Administrator repair of an existing YouTube lesson's transcript timing through the one local pipeline (10 §BE). */
    ListeningMaterialDetailDto reprocessYouTubeMaterial(Long materialId);

    void deleteMaterial(Long id, Long userId);

    default void deleteMaterial(Long id) {
        deleteMaterial(id, null);
    }

    void completeSession(Long sessionId, Long userId);

    default void completeSession(Long sessionId) {
        completeSession(sessionId, null);
    }
}

