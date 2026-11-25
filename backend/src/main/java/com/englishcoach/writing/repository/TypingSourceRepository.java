package com.englishcoach.writing.repository;

import com.englishcoach.writing.dto.TypingSourceDto;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import java.util.*;

/** Reads existing learner-authored text only. No prompts, feedback, AI or writes. */
@Repository
@RequiredArgsConstructor
public class TypingSourceRepository {
    private final NamedParameterJdbcTemplate jdbc;

    private String source(String category) {
        return switch (category) {
            // Latest accepted submitted answer per exercise unit/passage, across sessions.
            case "sentence" -> """
                SELECT DISTINCT ON (a.unit_id) a.id::text id, a.answer_text body,
                  'Sentence Translation'::text title, a.created_at saved_at
                FROM public.translation_attempts a
                JOIN public.translation_sessions s ON s.id=a.session_id AND s.user_id=:user
                WHERE a.user_id=:user AND a.action IN ('SUBMIT','REVISE') AND a.accepted=true
                  AND btrim(a.answer_text)<>''
                ORDER BY a.unit_id, a.created_at DESC, a.id DESC
                """;
            case "paragraph" -> """
                SELECT DISTINCT ON (a.passage_id) a.id::text id, a.submitted_text body,
                  'Paragraph Translation'::text title, a.created_at saved_at
                FROM public.translation_paragraph_attempts a
                JOIN public.translation_paragraph_sessions s ON s.id=a.session_id AND s.user_id=:user
                JOIN public.translation_paragraph_session_items i ON i.id=a.session_item_id AND i.session_id=s.id
                WHERE a.user_id=:user AND a.action IN ('SUBMIT','REVISE') AND a.accepted=true
                  AND btrim(a.submitted_text)<>''
                ORDER BY a.passage_id, a.created_at DESC, a.id DESC
                """;
            case "draft" -> """
                SELECT s.id, CASE WHEN btrim(s.working_text)<>'' THEN s.working_text ELSE d.content END body,
                  coalesce(nullif(s.task_snapshot->>'title',''),'Writing Draft') title, s.updated_at saved_at
                FROM public.writing_sessions s
                LEFT JOIN LATERAL (SELECT content FROM public.writing_submissions
                  WHERE session_id=s.id AND user_id=:user AND kind='COACH_DRAFT' AND btrim(content)<>''
                  ORDER BY ordinal DESC, created_at DESC, id DESC LIMIT 1) d ON true
                WHERE s.user_id=:user AND (btrim(s.working_text)<>'' OR d.content IS NOT NULL)
                """;
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid typing source category");
        };
    }
    public TypingSourceDto.Page list(Long user, String category, int page) {
        var rows = jdbc.query("SELECT id,title,saved_at FROM (" + source(category) +
            ") src ORDER BY saved_at DESC,id DESC LIMIT 25 OFFSET :offset",
            Map.of("user", user, "offset", Math.max(0, Math.min(page, 10000)) * 24),
            (rs, n) -> new TypingSourceDto(rs.getString("id"), rs.getString("title"), rs.getTimestamp("saved_at").toInstant(), null));
        return new TypingSourceDto.Page(rows.stream().limit(24).toList(), rows.size() > 24);
    }
    public Optional<TypingSourceDto> detail(Long user, String category, String id) {
        return jdbc.query("SELECT id,title,saved_at,body FROM (" + source(category) + ") src WHERE id=:id",
            Map.of("user", user, "id", id), (rs, n) -> new TypingSourceDto(rs.getString("id"),
                rs.getString("title"), rs.getTimestamp("saved_at").toInstant(), rs.getString("body"))).stream().findFirst();
    }
}
