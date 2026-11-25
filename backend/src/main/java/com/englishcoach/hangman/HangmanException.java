package com.englishcoach.hangman;
public final class HangmanException extends RuntimeException { public final int status; public final String code; public HangmanException(int status,String code){super(code);this.status=status;this.code=code;} }
