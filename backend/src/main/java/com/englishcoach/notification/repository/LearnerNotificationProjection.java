package com.englishcoach.notification.repository;

import java.time.Instant;

public interface LearnerNotificationProjection {
    Long getId();
    String getType();
    String getTitle();
    String getBody();
    String getActionUrl();
    Instant getPublishAt();
    Boolean getIsRead();
}
