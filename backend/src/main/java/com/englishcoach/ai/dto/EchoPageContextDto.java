package com.englishcoach.ai.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Where the learner is, by typed ids only (the module that owns the page defines the contract through its URL).
 * The server resolves every id with the learner's own visibility rules; an id the learner cannot see resolves to nothing.
 * {@code selection}, {@code clientVisibleExcerpt} and {@code bookMeta} are untrusted learner-provided data, never instructions.
 *
 * <p>Privacy rule (10 §AB): {@code clientVisibleExcerpt} and {@code bookMeta} are forwarded ONLY on explicit
 * learner turn submission (never stored from ambient {@code session.start}/{@code session.update} or {@code /warm}).</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record EchoPageContextDto(
        @Pattern(regexp = "GRAMMAR_TOPIC|READING_MATERIAL|BILINGUAL_READING|BOOK_EXCERPT|BOOK_ACTIVE|LISTENING_LESSON|SPEAKING_SCENARIO|SHADOWING_LESSON|COSMOS_WORD|EXAM_FAMILY|MODULE") String kind,
        @Pattern(regexp = "[a-z0-9-]{1,80}") String slug,
        @PositiveOrZero Long id,
        @Pattern(regexp = "[A-Za-z' -]{1,40}") String word,
        @Pattern(regexp = "ielts|toeic") String family,
        @Pattern(regexp = "[a-z-]{1,32}") String module,
        @Size(max = 600) String selection,
        @Size(max = 2800) String clientVisibleExcerpt,
        BookMeta bookMeta,
        @Size(max = 160) String pathname,
        @PositiveOrZero Integer viewportAnchorChar,
        @PositiveOrZero Integer playbackTimeSec) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record BookMeta(
            @Size(max = 160) String title,
            @Size(max = 120) String author,
            @Size(max = 120) String chapter,
            Integer pageNumber,
            Integer totalPages,
            Double progressPct,
            List<String> recentHighlights) {

        /** Backward-compatible 6-arg constructor. */
        public BookMeta(String title, String author, String chapter, Integer pageNumber, Integer totalPages, Double progressPct) {
            this(title, author, chapter, pageNumber, totalPages, progressPct, null);
        }
    }

    /** Backward-compatible 7-arg constructor preserved for all existing callers and tests. */
    public EchoPageContextDto(String kind, String slug, Long id, String word, String family, String module, String selection) {
        this(kind, slug, id, word, family, module, selection, null, null, null, null, null);
    }

    /** Backward-compatible 10-arg constructor. */
    public EchoPageContextDto(String kind, String slug, Long id, String word, String family, String module, String selection,
                              String clientVisibleExcerpt, BookMeta bookMeta, String pathname) {
        this(kind, slug, id, word, family, module, selection, clientVisibleExcerpt, bookMeta, pathname, null, null);
    }

    /** Strips on-demand local-book/viewport excerpts for ambient session metadata (10 §AB privacy). */
    public EchoPageContextDto withoutOnDemandExcerpts() {
        if (clientVisibleExcerpt == null && bookMeta == null) return this;
        return new EchoPageContextDto(kind, slug, id, word, family, module, selection, null, null, pathname, viewportAnchorChar, playbackTimeSec);
    }
}
