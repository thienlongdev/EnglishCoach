package com.englishcoach.exams.content;

import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.io.OutputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

/** Keeps unapproved packages out of the learner graph while preserving their original JSON for an author. */
@Service
@RequiredArgsConstructor
public class ExamPrivatePackageDrafts {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final ExamContentPackageValidator validator;
    private final ExamObjectStorage storage;

    public record Receipt(String packageId, int packageVersion, String contentHash, String status, boolean replay) {}

    @Transactional
    public Receipt retain(String raw, long actor) {
        ExamContentPackage pkg;
        try {
            pkg = mapper.readValue(raw, ExamContentPackage.class);
        } catch (JsonProcessingException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_PACKAGE_JSON");
        }
        var check = validator.validate(pkg);
        if (check.valid() || check.errors().isEmpty() ||
                check.errors().stream().anyMatch(e -> !"RIGHTS_NOT_APPROVED".equals(e.code())) ||
                pkg.licenses().stream().anyMatch(l -> !"PENDING".equals(l.legalStatus()) && !"APPROVED".equals(l.legalStatus())))
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "PRIVATE_DRAFT_REQUIRES_PENDING_RIGHTS_ONLY");
        for (var asset : pkg.assets()) verifyObject(asset);
        var m = pkg.manifest();
        int inserted = jdbc.update("""
                INSERT INTO exams.private_package_drafts (package_id, package_version, content_hash, package_json, created_by)
                VALUES (?, ?, ?, CAST(? AS json), ?) ON CONFLICT (package_id, package_version) DO NOTHING
                """, m.packageId(), m.packageVersion(), check.computedContentHash(), raw, actor);
        if (inserted == 0) {
            String prior = jdbc.queryForObject("""
                    SELECT content_hash FROM exams.private_package_drafts WHERE package_id = ? AND package_version = ?
                    """, String.class, m.packageId(), m.packageVersion());
            if (!check.computedContentHash().equals(prior))
                throw new ResponseStatusException(HttpStatus.CONFLICT, "PRIVATE_DRAFT_IDENTITY_CONFLICT");
        }
        return new Receipt(m.packageId(), m.packageVersion(), check.computedContentHash(), "PRIVATE_DRAFT", inserted == 0);
    }

    public Optional<String> read(String id, int version) {
        return jdbc.queryForList("""
                SELECT package_json::text FROM exams.private_package_drafts WHERE package_id = ? AND package_version = ?
                """, String.class, id, version).stream().findFirst();
    }

    void verifyObject(AssetRecord asset) {
        String hash = asset.sha256Hash();
        if (!hash.matches("[0-9a-f]{64}") || !asset.objectKey().matches(
                "assets/by-sha256/" + hash.substring(0, 2) + "/" + hash + "\\.[a-z0-9]+"))
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "PRIVATE_MEDIA_KEY_INVALID");
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            try (var input = new DigestInputStream(storage.getObjectStream(asset.objectKey()), digest)) {
                long bytes = input.transferTo(OutputStream.nullOutputStream());
                if (bytes != asset.byteSize() || !hash.equals(HexFormat.of().formatHex(digest.digest())))
                    throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "PRIVATE_MEDIA_MISMATCH");
            }
        } catch (java.io.UncheckedIOException | IOException e) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "PRIVATE_MEDIA_UNAVAILABLE");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
