package com.englishcoach.dictionary.provider;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.sqlite.SQLiteConfig;
import org.sqlite.SQLiteDataSource;

import jakarta.annotation.PostConstruct;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.*;

/**
 * Local English-Vietnamese Lexical Dictionary Provider.
 * Queries an offline read-only SQLite database (dictionary_en_vi.db)
 * derived from open linguistic datasets (MinhQND / Skypedia, CC BY-SA 4.0).
 *
 * The trusted EN-VI baseline of dictionary lookups: Vietnamese senses of single words ({@link #lookupEntry}) and
 * multi-word entries ({@link #lookup}), autocomplete, and the games' exact lookups.
 * Zero AI / Zero external network calls.
 */
@Slf4j
@Component
public class LocalEnViLexicalProvider {

    @Value("${dictionary.en-vi.sqlite-path:}")
    private String configuredPath;

    private SQLiteDataSource dataSource;
    private boolean available = false;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class EnViDefinition {
        private String definition;
        private String pos;
        private String subPos;
        private String example;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class EnViLexicalResult {
        private String word;
        private List<EnViDefinition> definitions;
    }

    @PostConstruct
    public void init() {
        try {
            File dbFile = resolveDatabaseFile();
            if (dbFile == null || !dbFile.exists() || !dbFile.isFile()) {
                log.warn("[LOCAL_EN_VI_PROVIDER] SQLite database file not found. Provider disabled.");
                this.available = false;
                return;
            }

            SQLiteConfig config = new SQLiteConfig();
            config.setReadOnly(true);

            this.dataSource = new SQLiteDataSource(config);
            this.dataSource.setUrl("jdbc:sqlite:" + dbFile.getAbsolutePath());

            // Validate connectivity
            try (Connection conn = dataSource.getConnection();
                 PreparedStatement stmt = conn.prepareStatement("SELECT COUNT(*) FROM words")) {
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        long count = rs.getLong(1);
                        log.info("[LOCAL_EN_VI_PROVIDER] Initialized read-only SQLite dictionary at '{}' with {} words",
                                dbFile.getAbsolutePath(), count);
                        this.available = true;
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[LOCAL_EN_VI_PROVIDER] Failed to initialize SQLite provider: {}", e.getMessage());
            this.available = false;
        }
    }

    private File resolveDatabaseFile() {
        // 1. Configured path
        if (configuredPath != null && !configuredPath.isBlank()) {
            File f = new File(configuredPath);
            if (f.exists() && f.isFile()) return f;
        }

        // 2. Relative filesystem paths
        String[] candidatePaths = {
                "backend/src/main/resources/lexical/dictionary_en_vi.db",
                "src/main/resources/lexical/dictionary_en_vi.db",
                "/app/storage/lexical/dictionary_en_vi.db",
                "storage/lexical/dictionary_en_vi.db",
                "data/dictionary_en_vi.db",
                "/app/data/dictionary_en_vi.db"
        };

        for (String p : candidatePaths) {
            File f = new File(p);
            if (f.exists() && f.isFile()) {
                return f;
            }
        }

        // 3. Classpath resource extraction if inside packaged JAR
        try {
            ClassPathResource resource = new ClassPathResource("lexical/dictionary_en_vi.db");
            if (resource.exists()) {
                try {
                    File file = resource.getFile();
                    if (file.exists() && file.isFile()) return file;
                } catch (Exception ignored) {
                    // Resource is inside JAR, extract to temp directory
                }

                Path tempDir = Path.of(System.getProperty("java.io.tmpdir"), "english_coach_dict");
                Files.createDirectories(tempDir);
                Path tempDb = tempDir.resolve("dictionary_en_vi.db");

                long resLength = resource.contentLength();
                if (!Files.exists(tempDb) || (resLength > 0 && Files.size(tempDb) != resLength)) {
                    log.info("[LOCAL_EN_VI_PROVIDER] Extracting packaged dictionary_en_vi.db to '{}'...", tempDb);
                    try (InputStream in = resource.getInputStream()) {
                        Files.copy(in, tempDb, StandardCopyOption.REPLACE_EXISTING);
                    }
                }
                if (Files.exists(tempDb)) {
                    return tempDb.toFile();
                }
            }
        } catch (Exception e) {
            log.debug("[LOCAL_EN_VI_PROVIDER] Classpath resource check failed: {}", e.getMessage());
        }

        return null;
    }

    public boolean isAvailable() {
        return available && dataSource != null;
    }

    /** Exact local-only lookup: no lemma, spelling expansion, network or writes. */
    public Optional<EnViLexicalResult> lookupExactLocal(String normalizedWord) {
        return isAvailable() ? queryExact(normalizedWord) : Optional.empty();
    }

    /** Exact local-only headword entry in the entry's own sense order (word_definitions id), with IPA. */
    public Optional<EnViEntry> lookupEntryExactLocal(String normalizedWord) {
        return isAvailable() ? queryEntry(normalizedWord) : Optional.empty();
    }

    /** Candidate keys from the canonical corpus, not a separate bot dictionary. */
    public List<String> localWordKeys() {
        if (!isAvailable()) return List.of();
        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(
                     "SELECT word FROM words WHERE length(word) BETWEEN 3 AND 8 ORDER BY word LIMIT 120000")) {
            stmt.setQueryTimeout(5);
            try (ResultSet rs = stmt.executeQuery()) {
                List<String> words = new ArrayList<>();
                while (rs.next()) words.add(rs.getString(1));
                return List.copyOf(words);
            }
        } catch (Exception e) {
            log.warn("Local dictionary candidate index unavailable");
            return List.of();
        }
    }

    /** One autocomplete row: the word and its first Vietnamese definition (may be null). */
    public record Suggestion(String word, String meaning) {}

    /**
     * Autocomplete from the canonical corpus: words starting with {@code prefix} (index range scan, at most 3,000 rows
     * looked at), the exact word first, then words with more recorded senses (common words), then shorter ones.
     * Read-only, local, bounded; no network and no AI.
     */
    public List<Suggestion> suggest(String prefix, int limit) {
        if (!isAvailable() || prefix == null) return List.of();
        String clean = prefix.trim().toLowerCase(java.util.Locale.ROOT).replaceAll("\\s+", " ");
        if (clean.length() < 2 || clean.length() > 40) return List.of();
        int bounded = Math.max(1, Math.min(limit, 10));
        String upper = clean.substring(0, clean.length() - 1) + (char) (clean.charAt(clean.length() - 1) + 1);
        String sql = "SELECT word, (SELECT d.definition FROM word_definitions wd JOIN definitions d ON d.id = wd.definition_id "
                + "WHERE wd.word_id = c.id ORDER BY d.id LIMIT 1) AS meaning FROM ("
                + "SELECT w.id, w.word, (SELECT COUNT(*) FROM word_definitions wd WHERE wd.word_id = w.id) AS senses "
                + "FROM words w WHERE w.word >= ? AND w.word < ? LIMIT 3000) c "
                + "ORDER BY (c.word = ?) DESC, c.senses DESC, length(c.word), c.word LIMIT ?";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(sql)) {
            stmt.setQueryTimeout(3);
            stmt.setString(1, clean);
            stmt.setString(2, upper);
            stmt.setString(3, clean);
            stmt.setInt(4, bounded);
            try (ResultSet rs = stmt.executeQuery()) {
                List<Suggestion> out = new ArrayList<>();
                while (rs.next()) {
                    String meaning = rs.getString("meaning");
                    out.add(new Suggestion(rs.getString("word"), meaning != null ? meaning.trim() : null));
                }
                return List.copyOf(out);
            }
        } catch (Exception e) {
            log.warn("[LOCAL_EN_VI_PROVIDER] Suggestion query failed");
            return List.of();
        }
    }

    public Optional<EnViLexicalResult> lookup(String query) {
        if (!isAvailable() || query == null || query.isBlank()) {
            return Optional.empty();
        }

        String clean = query.trim().toLowerCase().replaceAll("\\s+", " ");
        List<String> candidates = getLookupCandidates(clean);

        for (String candidate : candidates) {
            Optional<EnViLexicalResult> res = queryExact(candidate);
            if (res.isPresent() && !res.get().getDefinitions().isEmpty()) {
                return res;
            }
        }

        return Optional.empty();
    }

    private List<String> getLookupCandidates(String clean) {
        List<String> candidates = new ArrayList<>();
        candidates.add(clean);

        // Unicode apostrophe normalization
        String apostrophe = clean.replace('’', '\'').replace('‘', '\'');
        if (!apostrophe.equals(clean)) {
            candidates.add(apostrophe);
        }

        // Hyphen vs space
        if (clean.contains(" ")) {
            candidates.add(clean.replace(' ', '-'));
        } else if (clean.contains("-")) {
            candidates.add(clean.replace('-', ' '));
        }

        return candidates;
    }

    /** A word's Vietnamese senses in the dictionary's own order, with its first recorded IPA (may be null). */
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class EnViEntry {
        private String word;
        private String ipa;
        private List<EnViDefinition> definitions;
    }

    /**
     * Single-word dictionary lookup (owner brief 2026-10-24): the senses as the source lists them (row order, which
     * puts the common meaning first; {@link #lookup} keeps definition-id order for its existing callers) plus the
     * IPA. Exact word first, then the apostrophe / hyphen variants. Local and read-only: no network, no writes.
     */
    public Optional<EnViEntry> lookupEntry(String query) {
        if (!isAvailable() || query == null || query.isBlank()) return Optional.empty();
        String clean = query.trim().toLowerCase(java.util.Locale.ROOT).replaceAll("\\s+", " ");
        for (String candidate : getLookupCandidates(clean)) {
            Optional<EnViEntry> hit = queryEntry(candidate);
            if (hit.isPresent()) return hit;
        }
        return Optional.empty();
    }

    private Optional<EnViEntry> queryEntry(String word) {
        String sql = "SELECT w.id, d.definition, d.pos, d.sub_pos, wd.example, "
                + "(SELECT p.ipa FROM pronunciations p WHERE p.word_id = w.id ORDER BY p.id LIMIT 1) AS ipa "
                + "FROM words w JOIN word_definitions wd ON w.id = wd.word_id JOIN definitions d ON wd.definition_id = d.id "
                + "WHERE w.word = ? ORDER BY w.id, wd.id";
        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(sql)) {
            stmt.setQueryTimeout(3);
            stmt.setString(1, word);
            try (ResultSet rs = stmt.executeQuery()) {
                List<EnViDefinition> list = new ArrayList<>();
                String ipa = null;
                long firstWordId = -1;
                while (rs.next()) {
                    long wordId = rs.getLong("id");
                    if (firstWordId < 0) firstWordId = wordId;
                    if (wordId != firstWordId) break; // one headword row (the unique index is word + lang_code)
                    if (ipa == null) ipa = rs.getString("ipa");
                    String def = rs.getString("definition");
                    if (def != null && !def.isBlank()) {
                        list.add(EnViDefinition.builder()
                                .definition(def.trim())
                                .pos(rs.getString("pos"))
                                .subPos(rs.getString("sub_pos"))
                                .example(rs.getString("example"))
                                .build());
                    }
                }
                if (!list.isEmpty()) {
                    return Optional.of(EnViEntry.builder().word(word).ipa(ipa).definitions(list).build());
                }
            }
        } catch (Exception e) {
            log.warn("[LOCAL_EN_VI_PROVIDER] Entry query failed for '{}': {}", word, e.getMessage());
        }
        return Optional.empty();
    }

    private Optional<EnViLexicalResult> queryExact(String word) {
        String sql = "SELECT d.definition, d.pos, d.sub_pos, wd.example " +
                     "FROM words w " +
                     "JOIN word_definitions wd ON w.id = wd.word_id " +
                     "JOIN definitions d ON wd.definition_id = d.id " +
                     "WHERE w.word = ? " +
                     "ORDER BY d.id";

        try (Connection conn = dataSource.getConnection();
             PreparedStatement stmt = conn.prepareStatement(sql)) {
            stmt.setString(1, word);
            try (ResultSet rs = stmt.executeQuery()) {
                List<EnViDefinition> list = new ArrayList<>();
                while (rs.next()) {
                    String def = rs.getString("definition");
                    if (def != null && !def.isBlank()) {
                        list.add(EnViDefinition.builder()
                                .definition(def.trim())
                                .pos(rs.getString("pos"))
                                .subPos(rs.getString("sub_pos"))
                                .example(rs.getString("example"))
                                .build());
                    }
                }
                if (!list.isEmpty()) {
                    return Optional.of(EnViLexicalResult.builder()
                            .word(word)
                            .definitions(list)
                            .build());
                }
            }
        } catch (Exception e) {
            log.warn("[LOCAL_EN_VI_PROVIDER] Query error for '{}': {}", word, e.getMessage());
        }

        return Optional.empty();
    }
}
