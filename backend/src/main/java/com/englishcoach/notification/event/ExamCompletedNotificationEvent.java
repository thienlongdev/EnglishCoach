package com.englishcoach.notification.event;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationTemplates;

import java.util.UUID;

public record ExamCompletedNotificationEvent(
        Long userId,
        UUID attemptId,
        String examName,
        Object score
) {
    public CreateNotificationCommand toCommand() {
        String cleanExamName = (examName != null && !examName.isBlank()) ? examName : "chính thức";
        String title = NotificationTemplates.examCompletedTitle(cleanExamName);
        String content = NotificationTemplates.examCompletedContent(cleanExamName, score != null ? score : "hoàn tất");
        String dedupeKey = "EXAM_COMPLETED:" + attemptId;
        String actionUrl = "/exams/attempts/" + attemptId + "/results";

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
