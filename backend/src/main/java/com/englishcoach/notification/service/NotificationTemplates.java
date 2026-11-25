package com.englishcoach.notification.service;

public final class NotificationTemplates {
    private NotificationTemplates() {}

    public static final String BRANDING_SENDER = "EnglishCoach Hệ thống";

    // MILESTONE - Exam
    public static String examCompletedTitle(String examName) {
        return "Hoàn thành bài thi " + (examName != null ? examName : "");
    }

    public static String examCompletedContent(String examName, Object score) {
        return "Chúc mừng bạn đã hoàn thành bài thi " + (examName != null ? examName : "") + " với điểm số " + score + "!";
    }

    // MILESTONE - Flashcard
    public static String flashcardSessionTitle() {
        return "Cột mốc học từ vựng";
    }

    public static String flashcardSessionContent(int count) {
        return "Bạn đã hoàn thành phiên học từ vựng với " + count + " thẻ ghi nhớ!";
    }

    public static String flashcardDailyGoalTitle() {
        return "Hoàn thành mục tiêu từ vựng";
    }

    public static String flashcardDailyGoalContent(int count) {
        return "Chúc mừng bạn đã hoàn thành mục tiêu học " + count + " thẻ từ vựng hôm nay!";
    }

    // REVIEW_DUE - Flashcards that became due today (one reminder per local day)
    public static String flashcardDueTitle(long count) {
        return "Bạn có " + count + " từ cần ôn hôm nay";
    }

    public static String flashcardDueContent(long count) {
        return "Đã đến ngày ôn " + count + " từ bạn từng học. Ôn ngay để nhớ lâu hơn.";
    }

    // STREAK - Extended
    public static String streakExtendedTitle(int days) {
        return "Duy trì chuỗi học tập " + days + " ngày";
    }

    public static String streakExtendedContent(int days) {
        return "Bạn đã duy trì streak " + days + " ngày liên tiếp!";
    }

    // STREAK - At Risk
    public static String streakAtRiskTitle() {
        return "Bảo vệ chuỗi học tập của bạn";
    }

    public static String streakAtRiskContent(int days) {
        return "Sắp hết ngày: học một bài ngắn để bảo vệ chuỗi " + days + " ngày nhé!";
    }

    // STREAK - Milestone
    public static String streakMilestoneTitle(int days) {
        return "Cột mốc chuỗi học tập " + days + " ngày";
    }

    public static String streakMilestoneContent(int days) {
        return "Chúc mừng bạn đã đạt cột mốc streak " + days + " ngày liên tiếp!";
    }
}
