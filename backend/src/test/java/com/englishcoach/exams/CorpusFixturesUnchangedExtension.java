package com.englishcoach.exams;

import org.junit.jupiter.api.extension.AfterAllCallback;
import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.ExtensionContext;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.fail;

/**
 * Exams Recovery Phase 4.1E — tests must never rewrite repository exam corpus fixtures in place. Hashes every file of
 * the guarded corpus roots before a test class and fails the class when any file was added, removed or changed after
 * it (byte-identical check). Guarded: the original pilot packages ({@code content/exams/original-pilot}) and the staged
 * canonical packages ({@code imports/exams/staging/extracted}). Generated REPORTS are not fixtures and are not guarded.
 * Missing roots (no local corpus) are skipped.
 */
public class CorpusFixturesUnchangedExtension implements BeforeAllCallback, AfterAllCallback {

    static final List<Path> GUARDED = List.of(
            Path.of("..", "content", "exams", "original-pilot"),
            Path.of("..", "imports", "exams", "staging", "extracted"));

    private static final ExtensionContext.Namespace NS = ExtensionContext.Namespace.create(CorpusFixturesUnchangedExtension.class);

    @Override
    public void beforeAll(ExtensionContext context) throws Exception {
        context.getStore(NS).put("before", fingerprint());
    }

    @Override
    @SuppressWarnings("unchecked")
    public void afterAll(ExtensionContext context) throws Exception {
        Map<String, String> before = context.getStore(NS).get("before", Map.class);
        List<String> changed = diff(before, fingerprint());
        if (!changed.isEmpty()) {
            fail(context.getDisplayName() + " modified repository exam corpus fixtures in place: " + changed);
        }
    }

    /** Relative path → SHA-256 of every regular file under the guarded roots. */
    public static Map<String, String> fingerprint() throws IOException {
        Map<String, String> out = new TreeMap<>();
        for (Path root : GUARDED) {
            if (!Files.isDirectory(root)) continue;
            try (Stream<Path> s = Files.walk(root)) {
                for (Path p : s.filter(Files::isRegularFile).sorted().toList()) {
                    out.put(root.relativize(p).toString().replace('\\', '/') + "@" + root.getFileName(), sha256(p));
                }
            }
        }
        return out;
    }

    public static List<String> diff(Map<String, String> before, Map<String, String> after) {
        List<String> changed = new ArrayList<>();
        Set<String> keys = new TreeSet<>(before.keySet());
        keys.addAll(after.keySet());
        for (String k : keys) {
            if (!Objects.equals(before.get(k), after.get(k))) changed.add(k);
        }
        return changed;
    }

    private static String sha256(Path p) throws IOException {
        try (InputStream in = Files.newInputStream(p)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            return HexFormat.of().formatHex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
