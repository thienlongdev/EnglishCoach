package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.WritingSessionDto;
import com.englishcoach.writing.dto.WritingSourceContextDto;
import com.englishcoach.writing.enums.WritingSourceType;

import java.util.List;

public interface WritingSourceAdapterService {

    WritingSourceContextDto getSourceContext(Long userId, WritingSourceType sourceType, String sourceId);

    List<WritingSourceContextDto> getAvailableSourceContexts(Long userId, WritingSourceType sourceType);

    WritingSessionDto createSessionFromSource(Long userId, WritingSourceType sourceType, String sourceId);
}
