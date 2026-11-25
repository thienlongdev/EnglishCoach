package com.englishcoach.community.entity;

public enum ReactionType {
    // 5 Default primary reactions
    LOVE,       // ❤️ Yêu thích
    HAHA,       // 😂 Haha
    SUPPORT,    // 💪 Cố lên
    SAD,        // 😢 Buồn
    USEFUL,     // 💡 Hữu ích

    // Extended reactions
    WOW,        // 😮 Bất ngờ
    CONFUSED,   // 😕 Khó hiểu
    ANGRY,      // 😡 Tức giận
    CLAP,       // 👏 Hay quá
    FIRE,       // 🔥 Quá đỉnh
    THINKING,   // 🤔 Suy ngẫm
    CELEBRATE,  // 🎉 Chúc mừng

    // Backward-compatible legacy types
    LIKE,       // maps to LOVE
    IDEA,       // maps to USEFUL
    STRONG;     // maps to SUPPORT

    public ReactionType canonical() {
        return switch (this) {
            case LIKE -> LOVE;
            case IDEA -> USEFUL;
            case STRONG -> SUPPORT;
            default -> this;
        };
    }
}

