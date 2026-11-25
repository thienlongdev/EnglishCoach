package com.englishcoach.writing.translation.dto;

import lombok.*;

import java.time.Instant;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationDraftResponse {
    private UUID sessionId;
    private short unitOrdinal;
    private String draftText;
    private long sessionRevision;
    private Instant savedAt;
}
