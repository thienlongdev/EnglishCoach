package com.englishcoach.vocabulary.service;

import com.englishcoach.vocabulary.dto.VocabularyCourseDto;
import com.englishcoach.vocabulary.repository.VocabularyCourseRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class VocabularyService {

    private final VocabularyCourseRepository repository;

    @Transactional(readOnly = true)
    public List<VocabularyCourseDto> getAllCourses() {
        return repository.findAll().stream()
                .map(VocabularyCourseDto::fromEntity)
                .toList();
    }
}
