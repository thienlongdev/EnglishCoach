package com.englishcoach.vocabulary.controller;

import com.englishcoach.vocabulary.dto.VocabularyCourseDto;
import com.englishcoach.vocabulary.service.VocabularyService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/vocabulary-courses")
@RequiredArgsConstructor
public class VocabularyController {

    private final VocabularyService vocabularyService;

    @GetMapping
    public ResponseEntity<List<VocabularyCourseDto>> getAllCourses() {
        return ResponseEntity.ok(vocabularyService.getAllCourses());
    }
}
