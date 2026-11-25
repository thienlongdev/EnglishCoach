package com.englishcoach.reading.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Fail closed: source approval alone does not approve an individual text. */
public final class ReadingCorpusValidator {
    private ReadingCorpusValidator() {}
    public static String hash(String text) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    public static void validate(JsonNode registry, JsonNode corpus) {
        if (!registry.isArray() || !corpus.isArray() || corpus.size() < 1 || corpus.size() > 250) fail("Invalid corpus size");
        Map<String, JsonNode> sources = new HashMap<>();
        for (var source : registry) {
            String id = source.path("id").asText();
            if (id.isBlank() || sources.put(id, source) != null) fail("Duplicate registry source");
        }
        Set<String> urls = new HashSet<>(), hashes = new HashSet<>(), titles = new HashSet<>();
        for (var item : corpus) {
            var source = sources.get(item.path("sourceId").asText());
            if (source == null || !source.path("fullTextAllowed").asBoolean() || source.path("metadataOnly").asBoolean()
                    || !Set.of("PUBLIC_DOMAIN", "FULL_REPUBLICATION_ALLOWED", "OPEN_LICENSE").contains(source.path("reuseMode").asText())) fail("Unapproved source rights");
            if (!source.path("reviewedDate").asText().matches("\\d{4}-\\d{2}-\\d{2}") || !source.path("officialRightsUrl").asText().startsWith("https://")) fail("Missing rights evidence");
            String url = item.path("sourceUrl").asText(), body = item.path("contentText").asText(), title = item.path("title").asText();
            if (!item.path("sourceName").asText().equals(source.path("sourceName").asText())) fail("Source name mismatch");
            URI uri;
            try { uri = URI.create(url); } catch (Exception e) { throw new IllegalArgumentException("Invalid canonical URL"); }
            if (!"https".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || !source.path("host").asText().equals(uri.getHost()) || !url.startsWith(source.path("baseUrl").asText())) fail("Source URL outside approval scope");
            if (!urls.add(url) || !titles.add(title.toLowerCase(Locale.ROOT)) || !hashes.add(hash(body))) fail("Duplicate corpus identity/text/title");
            if (title.isBlank() || title.length() > 255 || body.length() > 30000 || body.contains("<") || body.contains(">")) fail("Invalid plain text");
            int words = body.trim().split("\\s+").length;
            if (words < 150 || words > 2500 || words != item.path("wordCount").asInt() || !hash(body).equals(item.path("bodySha256").asText())) fail("Invalid body size/hash/count");
            var paragraphs = body.split("\\n\\n");
            if (paragraphs.length < 2 || Arrays.stream(paragraphs).map(String::strip).distinct().count() != paragraphs.length) fail("Duplicate/missing paragraphs");
            long latin = body.chars().filter(c -> c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z').count();
            long letters = body.codePoints().filter(Character::isLetter).count();
            if (letters == 0 || latin * 1.0 / letters < 0.95 || body.indexOf('\uFFFD') >= 0
                    || !body.toLowerCase(Locale.ROOT).matches("(?s).*\\b(the|and|of|with|for)\\b.*")) fail("English/encoding validation failed");
            String lower = body.toLowerCase(Locale.ROOT);
            if (List.of("enable javascript","accept all cookies","subscribe to our","privacy policy","skip to content","all rights reserved").stream().anyMatch(lower::contains)) fail("Navigation/boilerplate in body");
            if (!Set.of("A1","A2","B1","B2","C1","C2").contains(item.path("difficultyLevel").asText())
                    || !item.path("levelMethod").asText().equals("APPROXIMATE_READABILITY") || item.path("topic").asText().isBlank()
                    || item.path("topic").asText().length() > 80 || item.path("description").asText().length() > 240) fail("Missing learning metadata");
            if (!item.path("reviewStatus").asText().equals("APPROVED") || item.path("rightsExceptionFound").asBoolean(true)
                    || item.path("rightsReviewNote").asText().isBlank()) fail("Item rights review missing");
            if (!item.path("sourceSnapshotSha256").asText().matches("[a-f0-9]{64}")
                    || !item.path("reviewedDate").asText().matches("\\d{4}-\\d{2}-\\d{2}")
                    || item.path("transformationNote").asText().isBlank()) fail("Missing item provenance");
            String variant = item.path("contentVariant").asText();
            if (!Set.of("FULL_TEXT", "EXCERPT", "ADAPTATION").contains(variant)
                    || (variant.equals("ADAPTATION") && !source.path("adaptationAllowed").asBoolean())) fail("Transformation prohibited");
            if (!item.path("licenseCode").asText().equals(source.path("licenseCode").asText())
                    || !item.path("attribution").asText().contains(source.path("sourceName").asText())
                    || !item.path("attribution").asText().contains(url)
                    || !item.path("attribution").asText().contains(source.path("requiredNotice").asText())) fail("Attribution/license missing");
        }
    }
    public static void validateMetadata(JsonNode corpus, JsonNode metadata) {
        if (!metadata.isArray() || metadata.size() != corpus.size()) fail("Metadata sidecar does not match corpus");
        Map<String, JsonNode> indexed = new HashMap<>();
        for (var item : metadata) if (item.size() != 5 || indexed.put(item.path("sourceUrl").asText(),item) != null) fail("Invalid metadata sidecar");
        for (var item : corpus) {
            var meta = indexed.get(item.path("sourceUrl").asText());
            if (meta == null) fail("Missing metadata sidecar item");
            for (String key : List.of("sourceUrl","topic","description","licenseCode","attribution"))
                if (!item.path(key).equals(meta.path(key))) fail("Metadata differs from approved corpus");
        }
    }
    private static void fail(String reason) { throw new IllegalArgumentException(reason); }
}
