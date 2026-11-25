package com.englishcoach.avatarframe.dto;

/**
 * Normalized condition item for multi-requirement avatar frames.
 */
public record AvatarFrameConditionDto(
    String metric,
    double current,
    double target,
    double percent,
    String displayCurrent,
    String displayTarget
) {}
