package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.TypingSourceDto;
import com.englishcoach.writing.repository.TypingSourceRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@Service
@RequiredArgsConstructor
@Transactional(readOnly = true, timeout = 15)
public class TypingSourceService {
    private final TypingSourceRepository repository;
    public TypingSourceDto.Page list(Long user, String category, int page) {
        return repository.list(user, category, page);
    }
    public TypingSourceDto detail(Long user, String category, String id) {
        return repository.detail(user, category, id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Typing source not found"));
    }
}
