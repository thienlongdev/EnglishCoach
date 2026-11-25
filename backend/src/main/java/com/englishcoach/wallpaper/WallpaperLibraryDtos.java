package com.englishcoach.wallpaper;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Wire records of "Video YouTube của tôi". The owner is always the principal: no record carries a user id. */
public final class WallpaperLibraryDtos {

    private WallpaperLibraryDtos() {}

    /**
     * The learner's own background source for a saved YouTube entry — never the YouTube video itself.
     *
     * @param kind     LINK (an HTTPS link to a directly playable video file) or FILE (a file kept in the learner's browser)
     * @param url      LINK only
     * @param fileName FILE only: the file's name, so another device can say where the file is
     */
    public record Background(String kind, String url, String fileName) {}

    public record Entry(UUID id, String videoId, Background background, Instant createdAt, Instant updatedAt) {}

    public record EntryList(List<Entry> items, int limit) {}

    public record SaveRequest(@NotNull @Size(min = 11, max = 11) String videoId) {}

    public record SaveResponse(Entry entry, boolean created) {}

    /** One-time move of a learner's former device-only list (ids only, newest first) into their account. */
    public record ImportRequest(@NotNull @Size(max = WallpaperLibraryRules.MAX_IMPORT) List<String> videoIds) {}

    public record ImportResponse(List<Entry> items, int imported, int alreadySaved, int overLimit, int limit) {}

    /** {@code kind} null clears the background source. */
    public record BackgroundRequest(String kind, @Size(max = 2048) String url, @Size(max = 400) String fileName) {}
}
