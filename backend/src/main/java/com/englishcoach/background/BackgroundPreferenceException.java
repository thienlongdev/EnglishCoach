package com.englishcoach.background;

/**
 * A refused Echo Background Studio preference request: HTTP status plus stable public error code (never internals).
 */
public final class BackgroundPreferenceException extends RuntimeException {

    final int status;
    final String code;

    public BackgroundPreferenceException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }
}
