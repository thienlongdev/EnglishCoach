package com.englishcoach.notification.event;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationTemplates;

import java.time.LocalDate;

public record FlashcardSessionNotificationEvent(
        Long userId,
        String sessionOrDedupeId,
        int cardsReviewed,
        LocalDate date
) {
    public CreateNotificationCommand toCommand() {
        String title = NotificationTemplates.flashcardSessionTitle();
        String content = NotificationTemplates.flashcardSessionContent(cardsReviewed > 0 ? cardsReviewed : 10);
        String dedupeKey = sessionOrDedupeId != null ? sessionOrDedupeId : ("DAILY_GOAL:" + (date != null ? date : LocalDate.now()));
        String actionUrl = "/flashcards";

        return new CreateNotificationCommand(
                userId,
                NotificationCategory.MILESTONE,
                NotificationType.LEARNING_REMINDER,
                title,
                content,
                actionUrl,
                dedupeKey
        );
    }
}
