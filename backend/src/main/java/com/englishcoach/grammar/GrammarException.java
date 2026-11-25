package com.englishcoach.grammar;

/** A refused Grammar command: HTTP status + stable public code (never internals). */
public final class GrammarException extends RuntimeException {

    final int status;
    final String code;

    public GrammarException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
    public int status() { return status; }
    public String code() { return code; }
}
