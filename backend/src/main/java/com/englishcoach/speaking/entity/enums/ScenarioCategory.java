package com.englishcoach.speaking.entity.enums;

public enum ScenarioCategory {
    TRAVEL,
    DAILY_LIFE,
    BUSINESS,
    WORK,
    ACADEMIC,
    CASUAL;

    public static ScenarioCategory fromString(String val) {
        if (val == null || val.isBlank() || val.equalsIgnoreCase("ALL")) {
            return null;
        }
        for (ScenarioCategory cat : values()) {
            if (cat.name().equalsIgnoreCase(val.trim())) {
                return cat;
            }
        }
        throw new IllegalArgumentException("Invalid Scenario Category: '" + val + "'. Supported values: TRAVEL, DAILY_LIFE, BUSINESS, WORK, ACADEMIC, CASUAL, ALL.");
    }
}
