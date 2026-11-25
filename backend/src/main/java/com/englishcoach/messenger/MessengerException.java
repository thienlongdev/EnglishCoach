package com.englishcoach.messenger;

/** A refused Messenger command: HTTP status + stable public code, never internals. */
public final class MessengerException extends RuntimeException {
    final int status;
    final String code;

    public MessengerException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
