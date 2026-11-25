package com.englishcoach.flashcard.pvp.model;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PendingAttack {

    private String attackId;
    private String fromUserId;
    private String fromName;
    private String toUserId;
    private long createdAtMs;
    @Builder.Default
    private long telegraphMs = 2000L;
    private long executeAtMs;
    private ScheduledWord scheduledWord;
    @Builder.Default
    private boolean parried = false;
}
