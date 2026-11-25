package com.englishcoach.listening.service;

import com.englishcoach.listening.entity.TranscriptSegment;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;

/** One database exchange for the entire transcript AND its Dictation exercises, in the caller's transaction. */
@Component
@RequiredArgsConstructor
public class ListeningTranscriptWriter {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    @Transactional(propagation = org.springframework.transaction.annotation.Propagation.MANDATORY)
    public void write(Long materialId, List<TranscriptSegment> segments) {
        if (segments.isEmpty() || segments.size() > 10000) throw new IllegalArgumentException("Invalid transcript size");
        List<Map<String,Object>> rows = new ArrayList<>();
        for (int i=0; i<segments.size(); i++) {
            var s=segments.get(i);
            var row=new LinkedHashMap<String,Object>();
            row.put("position",i); row.put("start_ms",s.getStartTimeMs()); row.put("end_ms",s.getEndTimeMs());
            row.put("speaker",s.getSpeakerName()); row.put("text",s.getText()); row.put("words",s.getWordsJson());
            row.put("difficulty",s.getDifficultyScore()); rows.add(row);
        }
        final String payload;
        try { payload=mapper.writeValueAsString(rows); }
        catch (Exception e) { throw new IllegalArgumentException("Cannot serialize transcript",e); }
        // Explicit ids tie each exercise to its OWN input sentence. RETURNING order is never assumed.
        var ids=jdbc.queryForList("""
            WITH input AS MATERIALIZED (
                SELECT nextval(pg_get_serial_sequence('public.transcript_segments','id')) AS id, x.*
                FROM jsonb_to_recordset(CAST(? AS jsonb)) AS x(position int,start_ms int,end_ms int,
                     speaker text,text text,words text,difficulty double precision)
            ), saved AS (
                INSERT INTO public.transcript_segments(id,listening_material_id,start_time_ms,end_time_ms,
                     speaker_name,text,words_json,difficulty_score)
                SELECT id,?,start_ms,end_ms,speaker,text,words,difficulty FROM input RETURNING id
            ), exercises AS (
                INSERT INTO public.listening_exercises(listening_material_id,transcript_segment_id,exercise_type,
                     question_text,expected_answer,difficulty_score)
                SELECT ?,i.id,'DICTATION','Type the sentence exactly as spoken.',i.text,i.difficulty
                FROM input i JOIN saved s ON s.id=i.id RETURNING id
            )
            SELECT i.id,i.position FROM input i JOIN saved s ON s.id=i.id
            WHERE (SELECT count(*) FROM exercises)=(SELECT count(*) FROM input) ORDER BY i.position
            """,payload,materialId,materialId);
        if (ids.size()!=segments.size()) throw new IllegalStateException("Incomplete transcript write");
        for (var row:ids) segments.get(((Number)row.get("position")).intValue()).setId(((Number)row.get("id")).longValue());
    }
}
