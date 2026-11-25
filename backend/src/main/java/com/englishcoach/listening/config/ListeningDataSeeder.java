package com.englishcoach.listening.config;

import com.englishcoach.listening.entity.ListeningExercise;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.entity.enums.ExerciseType;
import com.englishcoach.listening.repository.ListeningExerciseRepository;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

@Component
@RequiredArgsConstructor
public class ListeningDataSeeder implements CommandLineRunner {

    private final ListeningMaterialRepository listeningMaterialRepository;
    private final TranscriptSegmentRepository transcriptSegmentRepository;
    private final ListeningExerciseRepository listeningExerciseRepository;

    @Override
    public void run(String... args) throws Exception {
        // Mock data seeding disabled to enforce 100% authentic YouTube ASR imported materials
    }
}
