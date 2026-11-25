package com.englishcoach.quizrush;

public final class RushException extends RuntimeException {
    final int status;
    public RushException(int status,String code){super(code);this.status=status;}
}
