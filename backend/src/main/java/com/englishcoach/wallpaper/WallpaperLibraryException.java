package com.englishcoach.wallpaper;

/** A refused wallpaper-library command: HTTP status + stable public code (never internals). */
public final class WallpaperLibraryException extends RuntimeException {

    final int status;
    final String code;

    public WallpaperLibraryException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
