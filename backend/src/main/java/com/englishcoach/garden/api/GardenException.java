package com.englishcoach.garden.api;

import java.util.Map;

/**
 * A business rejection with a stable code (GDD 03 §12). The frontend maps codes to Vietnamese sentences; {@code details}
 * carries safe numbers only (e.g. the missing coins, the unlock level).
 */
public final class GardenException extends RuntimeException {

    public final int status;
    public final String code;
    public final Map<String, Object> details;

    public GardenException(int status, String code) {
        this(status, code, Map.of());
    }

    public GardenException(int status, String code, Map<String, Object> details) {
        super(code);
        this.status = status;
        this.code = code;
        this.details = details;
    }

    public static GardenException conflict(String code) {
        return new GardenException(409, code);
    }

    public static GardenException conflict(String code, Map<String, Object> details) {
        return new GardenException(409, code, details);
    }
}
