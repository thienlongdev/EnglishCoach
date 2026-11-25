package com.englishcoach.speaking.topic;

/** A refused topic-practice command: HTTP status + stable public code (never internals). */
public final class TopicException extends RuntimeException {

    final int status;
    final String code;

    public TopicException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
