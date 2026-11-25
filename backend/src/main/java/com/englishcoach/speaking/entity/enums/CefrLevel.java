package com.englishcoach.speaking.entity.enums;

public enum CefrLevel {
    A1,
    A2,
    B1,
    B2,
    C1,
    C2;

    public static CefrLevel fromString(String val) {
        if (val == null || val.isBlank() || val.equalsIgnoreCase("ALL")) {
            return null;
        }
        for (CefrLevel lvl : values()) {
            if (lvl.name().equalsIgnoreCase(val.trim())) {
                return lvl;
            }
        }
        throw new IllegalArgumentException("Invalid CEFR level: '" + val + "'. Supported values: A1, A2, B1, B2, C1, C2, ALL.");
    }
}
