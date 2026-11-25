package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.ShadowingAnalysisResponseDto;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Instant;

@Repository
@RequiredArgsConstructor
public class ShadowingAnalysisReceipts {
    private static final int MAX_ENGINE_VERSION_LEN = 128;

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public record Receipt(
            long session,
            long unit,
            String audioSha256,
            ShadowingAnalysisResponseDto result,
            String engineVersion,
            Instant createdAt,
            Instant expiresAt,
            Instant consumedAt
    ) {
        public Receipt(long session, long unit, String digest, ShadowingAnalysisResponseDto result) {
            this(session, unit, digest, result, resolveEngineVersion(result), null, null, null);
        }

        public String digest() {
            return audioSha256;
        }
    }

    public ShadowingAnalysisResponseDto lookup(long user, String key, long session, long unit, String digest) {
        Receipt receipt = readReceipt(user, key, session, unit, digest, false);
        return receipt == null ? null : receipt.result();
    }

    public Receipt forRecording(long user, String key, long session, long unit) {
        Receipt receipt = readReceipt(user, key, session, unit, null, true);
        if (receipt == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Analyze this recording first");
        }
        if (receipt.expiresAt() != null && receipt.expiresAt().isBefore(Instant.now())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "RECEIPT_EXPIRED");
        }
        if (receipt.consumedAt() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "RECEIPT_ALREADY_CONSUMED");
        }
        return receipt;
    }

    public void markConsumed(long user, String key) {
        jdbc.update("""
                UPDATE public.shadowing_analysis_receipts
                SET consumed_at = NOW()
                WHERE user_id = ? AND attempt_key = ? AND consumed_at IS NULL
                """, user, key);
    }

    private Receipt readReceipt(long user, String key, long session, long unit, String digest, boolean lock) {
        var rows = jdbc.query("""
                SELECT session_id, unit_id, audio_sha256, result_json, engine_version, created_at, expires_at, consumed_at
                FROM public.shadowing_analysis_receipts
                WHERE user_id = ? AND attempt_key = ?
                """ + (lock ? " FOR UPDATE" : ""), (rs, i) -> {
            try {
                String rawDigest = rs.getString(3);
                String sha = rawDigest != null ? rawDigest.trim() : null;
                ShadowingAnalysisResponseDto dto = json.readValue(rs.getString(4), ShadowingAnalysisResponseDto.class);
                String engineVer = rs.getString(5);
                Timestamp createdTs = rs.getTimestamp(6);
                Timestamp expiresTs = rs.getTimestamp(7);
                Timestamp consumedTs = rs.getTimestamp(8);
                return new Receipt(
                        rs.getLong(1),
                        rs.getLong(2),
                        sha,
                        dto,
                        engineVer,
                        createdTs != null ? createdTs.toInstant() : null,
                        expiresTs != null ? expiresTs.toInstant() : null,
                        consumedTs != null ? consumedTs.toInstant() : null
                );
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("Unreadable shadowing analysis receipt", e);
            }
        }, user, key);
        if (rows.isEmpty()) return null;
        var receipt = rows.getFirst();
        if (receipt.session() != session || receipt.unit() != unit || (digest != null && !digest.equals(receipt.audioSha256()))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Attempt identifier already belongs to another recording");
        }
        return receipt;
    }

    @Transactional
    public ShadowingAnalysisResponseDto issue(long user, String key, long session, long unit, String digest,
                                              ShadowingAnalysisResponseDto result) {
        String engineVersion = resolveEngineVersion(result);
        try {
            jdbc.update("""
                    INSERT INTO public.shadowing_analysis_receipts(
                        user_id, attempt_key, session_id, unit_id, audio_sha256, result_json,
                        created_at, expires_at, engine_version
                    )
                    VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL '30 minutes', ?)
                    ON CONFLICT (user_id, attempt_key) DO NOTHING
                    """, user, key, session, unit, digest, json.writeValueAsString(result), engineVersion);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot store shadowing analysis", e);
        }
        return lookup(user, key, session, unit, digest);
    }

    public static String resolveEngineVersion(ShadowingAnalysisResponseDto result) {
        if (result == null) {
            return null;
        }
        var v2 = result.getPronunciationV2();
        if (v2 == null) {
            return "ASR_ONLY";
        }
        String raw = v2.getEngineVersion();
        if (raw == null || raw.isBlank()) {
            return "pronunciation-v2.2";
        }
        String trimmed = raw.trim();
        return trimmed.length() > MAX_ENGINE_VERSION_LEN ? trimmed.substring(0, MAX_ENGINE_VERSION_LEN) : trimmed;
    }
}
