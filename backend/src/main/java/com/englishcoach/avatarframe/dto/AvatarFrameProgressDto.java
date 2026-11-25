package com.englishcoach.avatarframe.dto;

import java.util.List;

/**
 * Normalized server-authoritative progress contract.
 * Never calculated by the client.
 */
public record AvatarFrameProgressDto(
    double current,
    double target,
    double percent,
    String metric,
    String status,
    String displayCurrent,
    String displayTarget,
    List<AvatarFrameConditionDto> conditions
) {
    public AvatarFrameProgressDto(
        double current,
        double target,
        double percent,
        String metric,
        String status,
        String displayCurrent,
        String displayTarget
    ) {
        this(current, target, percent, metric, status, displayCurrent, displayTarget, null);
    }
}
