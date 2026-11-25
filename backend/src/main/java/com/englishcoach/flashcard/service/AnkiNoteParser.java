package com.englishcoach.flashcard.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.util.HtmlUtils;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Robust parser and sanitizer for Anki APKG notes.
 * Extracts normalized vocabulary terms, IPA, CEFR, meanings, and examples
 * while strictly adhering to database schema constraints (e.g. varchar 255).
 */
@Slf4j
@Component
public class AnkiNoteParser {

    public static final char ANKI_FIELD_SEPARATOR = 0x1F;
    private static final int MAX_VARCHAR_LENGTH = 255;

    private static final Pattern STYLE_TAG_PATTERN = Pattern.compile("<style[^>]*>.*?</style>",
            Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern SCRIPT_TAG_PATTERN = Pattern.compile("<script[^>]*>.*?</script>",
            Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern COMMENT_PATTERN = Pattern.compile("<!--.*?-->", Pattern.DOTALL);
    private static final Pattern SOUND_TAG_PATTERN = Pattern.compile("\\[sound:[^\\]]*\\]", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_TAG_PATTERN = Pattern.compile("<[^>]+>");
    private static final Pattern WHITESPACE_PATTERN = Pattern.compile("[\\r\\n\\t\\s]+");
    private static final Pattern CLOZE_PATTERN = Pattern.compile("\\{\\{c\\d+::(?<word>[^:}]+)(?:::.*?)?\\}\\}");
    private static final Pattern CEFR_STRICT_PATTERN = Pattern.compile("^(?i)(A1|A2|B1|B2|C1|C2)$");
    private static final Pattern CEFR_EXTRACT_PATTERN = Pattern.compile("(?i)\\b(A1|A2|B1|B2|C1|C2)\\b");

    /** A note number or id such as "29", "2_29" or "3-14" (never a vocabulary item). */
    private static final Pattern IDENTIFIER_PATTERN = Pattern.compile("^[0-9]+(?:[_.:/-][0-9]+)*$");
    /** A phonetic transcription written as /…/ or […]. */
    private static final Pattern IPA_PATTERN = Pattern.compile("^[\\[/][^\\[\\]/0-9]{1,60}[\\]/]$");

    public static boolean looksLikeIdentifier(String value) {
        return value != null && IDENTIFIER_PATTERN.matcher(value.trim()).matches();
    }

    public static boolean looksLikeIpa(String value) {
        return value != null && IPA_PATTERN.matcher(value.trim()).matches();
    }

    private final ObjectMapper objectMapper = new ObjectMapper();

    public record ParsedAnkiNote(
            String word,
            String ipa,
            String cefr,
            String meaning,
            String example,
            boolean valid,
            String skipReason
    ) {
        public static ParsedAnkiNote invalid(String reason) {
            return new ParsedAnkiNote(null, null, null, null, null, false, reason);
        }

        public static ParsedAnkiNote valid(String word, String ipa, String cefr, String meaning, String example) {
            return new ParsedAnkiNote(word, ipa, cefr, meaning, example, true, null);
        }
    }

    public record ModelFieldMapping(
            Integer wordOrd,
            Integer ipaOrd,
            Integer meaningOrd,
            Integer exampleOrd,
            Integer cefrOrd,
            List<String> fieldNames
    ) {}

    /**
     * Parses the JSON models string from SQLite col table into a map of modelId -> ModelFieldMapping.
     */
    public Map<Long, ModelFieldMapping> parseModels(String modelsJson) {
        Map<Long, ModelFieldMapping> result = new HashMap<>();
        if (modelsJson == null || modelsJson.isBlank()) {
            return result;
        }

        try {
            JsonNode root = objectMapper.readTree(modelsJson);
            Iterator<Map.Entry<String, JsonNode>> fields = root.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> entry = fields.next();
                try {
                    Long modelId = Long.parseLong(entry.getKey());
                    JsonNode modelNode = entry.getValue();
                    JsonNode fldsNode = modelNode.get("flds");

                    if (fldsNode != null && fldsNode.isArray()) {
                        Integer wordOrd = null;
                        Integer ipaOrd = null;
                        Integer meaningOrd = null;
                        Integer exampleOrd = null;
                        Integer cefrOrd = null;
                        List<String> fieldNames = new ArrayList<>();

                        for (JsonNode fieldDef : fldsNode) {
                            String name = fieldDef.has("name") ? fieldDef.get("name").asText().trim() : "";
                            int ord = fieldDef.has("ord") ? fieldDef.get("ord").asInt() : fieldNames.size();
                            fieldNames.add(name);

                            String lowerName = name.toLowerCase(Locale.ROOT);
                            if (wordOrd == null && isWordField(lowerName)) {
                                wordOrd = ord;
                            } else if (ipaOrd == null && isIpaField(lowerName)) {
                                ipaOrd = ord;
                            } else if (meaningOrd == null && isMeaningField(lowerName)) {
                                meaningOrd = ord;
                            } else if (exampleOrd == null && isExampleField(lowerName)) {
                                exampleOrd = ord;
                            } else if (cefrOrd == null && isCefrField(lowerName)) {
                                cefrOrd = ord;
                            }
                        }

                        result.put(modelId, new ModelFieldMapping(wordOrd, ipaOrd, meaningOrd, exampleOrd, cefrOrd, fieldNames));
                    }
                } catch (NumberFormatException ignored) {
                }
            }
        } catch (Exception e) {
            log.warn("Failed to parse Anki models JSON: {}", e.getMessage());
        }

        return result;
    }

    private boolean isWordField(String name) {
        return name.equals("word") || name.equals("term") || name.equals("expression")
                || name.equals("vocab") || name.equals("vocabulary") || name.equals("headword")
                || name.equals("target") || name.equals("target word") || name.equals("front")
                || name.equals("text") || name.equals("entry") || name.equals("spelling")
                || name.equals("english") || name.equals("en") || name.equals("eng");
    }

    private boolean isIpaField(String name) {
        return name.equals("ipa") || name.equals("phonetic") || name.equals("phonetics")
                || name.equals("pronunciation") || name.equals("reading") || name.equals("transcription")
                || name.equals("accent") || name.equals("kana");
    }

    private boolean isMeaningField(String name) {
        return name.equals("meaning") || name.equals("meanings") || name.equals("definition")
                || name.equals("definitions") || name.equals("back") || name.equals("translation")
                || name.equals("gloss") || name.equals("explanation") || name.equals("vietnamese")
                || name.equals("vi");
    }

    private boolean isExampleField(String name) {
        return name.equals("example") || name.equals("examples") || name.equals("sentence")
                || name.equals("sentences") || name.equals("context") || name.equals("usage")
                || name.equals("sample") || name.equals("sample sentence") || name.equals("phrase");
    }

    private boolean isCefrField(String name) {
        return name.equals("cefr") || name.equals("level") || name.equals("difficulty")
                || name.equals("grade") || name.equals("band");
    }

    /**
     * Parses an Anki note given its model mapping and raw fields string.
     */
    public ParsedAnkiNote parseNote(Long mid, String rawFlds, Map<Long, ModelFieldMapping> modelMappings) {
        if (rawFlds == null || rawFlds.isBlank()) {
            return ParsedAnkiNote.invalid("Empty note fields");
        }

        String[] rawParts = rawFlds.split(String.valueOf(ANKI_FIELD_SEPARATOR), -1);
        if (rawParts.length == 0) {
            return ParsedAnkiNote.invalid("No fields found in note");
        }

        ModelFieldMapping mapping = (mid != null && modelMappings != null) ? modelMappings.get(mid) : null;

        String rawWord = null;
        String rawIpa = null;
        String rawMeaning = null;
        String rawExample = null;
        String rawCefr = null;

        if (mapping != null) {
            if (mapping.wordOrd() != null && mapping.wordOrd() < rawParts.length) {
                rawWord = rawParts[mapping.wordOrd()];
            }
            if (mapping.ipaOrd() != null && mapping.ipaOrd() < rawParts.length) {
                rawIpa = rawParts[mapping.ipaOrd()];
            }
            if (mapping.meaningOrd() != null && mapping.meaningOrd() < rawParts.length) {
                rawMeaning = rawParts[mapping.meaningOrd()];
            }
            if (mapping.exampleOrd() != null && mapping.exampleOrd() < rawParts.length) {
                rawExample = rawParts[mapping.exampleOrd()];
            }
            if (mapping.cefrOrd() != null && mapping.cefrOrd() < rawParts.length) {
                rawCefr = rawParts[mapping.cefrOrd()];
            }
        }

        // Positional fallback if mapping was unavailable or word is null. Many shared decks start with a note number
        // ("2_29") and carry the transcription ("[skɑːf]") in its own field: the word is the first field that is
        // neither, a transcription goes to the IPA, and the remaining fields are meaning then example.
        if (rawWord == null) {
            int wordIndex = 0;
            for (int i = 0; i < rawParts.length; i++) {
                String candidate = sanitizeText(rawParts[i]);
                if (!candidate.isBlank() && !looksLikeIdentifier(candidate) && !looksLikeIpa(candidate)) {
                    wordIndex = i;
                    break;
                }
            }
            rawWord = rawParts.length > 0 ? rawParts[wordIndex] : "";
            for (int i = wordIndex + 1; i < rawParts.length; i++) {
                String value = sanitizeText(rawParts[i]);
                if (value.isBlank() || looksLikeIdentifier(value)) continue;
                if (looksLikeIpa(value)) {
                    if (rawIpa == null) rawIpa = rawParts[i];
                } else if (rawMeaning == null) {
                    rawMeaning = rawParts[i];
                } else if (rawExample == null) {
                    rawExample = rawParts[i];
                }
            }
        }
        // a transcription mapped (or placed) as the example is the IPA, never an example sentence
        if (rawExample != null && looksLikeIpa(sanitizeText(rawExample))) {
            if (rawIpa == null) rawIpa = rawExample;
            rawExample = null;
        }

        // Handle cloze markup if present in the raw word field
        String clozeExtractedWord = null;
        String clozeContextSentence = null;
        if (rawWord != null && rawWord.contains("{{c")) {
            Matcher clozeMatcher = CLOZE_PATTERN.matcher(rawWord);
            if (clozeMatcher.find()) {
                clozeExtractedWord = clozeMatcher.group("word");
                clozeContextSentence = CLOZE_PATTERN.matcher(rawWord).replaceAll(mr -> mr.group("word"));
            }
        }

        String word = clozeExtractedWord != null ? clozeExtractedWord : rawWord;
        word = sanitizeText(word);

        String example = rawExample != null ? sanitizeText(rawExample) : null;
        if (clozeContextSentence != null && (example == null || example.isBlank())) {
            example = sanitizeText(clozeContextSentence);
        }

        // If the candidate word is still > 255 chars, check if another field in the note was the actual word
        if (word != null && word.length() > MAX_VARCHAR_LENGTH) {
            boolean resolved = false;
            // Check subsequent fields for a candidate word (<= 100 chars, non-empty, not a sentence)
            for (int i = 0; i < rawParts.length; i++) {
                String candidate = sanitizeText(rawParts[i]);
                if (!candidate.isBlank() && candidate.length() <= 100 && !candidate.contains(".")) {
                    if (example == null || example.isBlank()) {
                        example = boundString(word, MAX_VARCHAR_LENGTH);
                    }
                    word = candidate;
                    resolved = true;
                    break;
                }
            }

            if (!resolved) {
                return ParsedAnkiNote.invalid("Word exceeds " + MAX_VARCHAR_LENGTH + " characters (" + word.length() + " chars)");
            }
        }

        if (word == null || word.isBlank()) {
            return ParsedAnkiNote.invalid("Empty word after sanitization");
        }

        if (word.length() > MAX_VARCHAR_LENGTH) {
            return ParsedAnkiNote.invalid("Word exceeds " + MAX_VARCHAR_LENGTH + " characters");
        }

        // Normalize IPA
        String ipa = null;
        if (rawIpa != null && !rawIpa.isBlank()) {
            ipa = sanitizeText(rawIpa);
            if (ipa.isBlank()) {
                ipa = null;
            } else {
                ipa = boundString(ipa, MAX_VARCHAR_LENGTH);
            }
        }

        // Normalize CEFR
        String cefr = null;
        if (rawCefr != null && !rawCefr.isBlank()) {
            String sanitizedCefr = sanitizeText(rawCefr);
            Matcher strictMatch = CEFR_STRICT_PATTERN.matcher(sanitizedCefr);
            if (strictMatch.matches()) {
                cefr = sanitizedCefr.toUpperCase(Locale.ROOT);
            } else {
                Matcher extractMatch = CEFR_EXTRACT_PATTERN.matcher(sanitizedCefr);
                if (extractMatch.find()) {
                    cefr = extractMatch.group(1).toUpperCase(Locale.ROOT);
                }
            }
        }

        // Normalize Meaning
        String meaning = rawMeaning != null ? sanitizeText(rawMeaning) : "";
        if (meaning.isBlank()) {
            meaning = "Imported from Anki Deck";
        }
        meaning = boundString(meaning, MAX_VARCHAR_LENGTH);

        // Normalize Example
        if (example == null || example.isBlank()) {
            example = "Imported from Anki Deck";
        }
        example = boundString(example, MAX_VARCHAR_LENGTH);

        return ParsedAnkiNote.valid(word, ipa, cefr, meaning, example);
    }

    /**
     * Strips styles, scripts, HTML comments, sound tags, HTML markup,
     * unescapes entities, and normalizes whitespace.
     */
    public String sanitizeText(String text) {
        if (text == null) {
            return "";
        }

        String cleaned = text;

        // 1. Remove style and script blocks with their internal contents
        cleaned = STYLE_TAG_PATTERN.matcher(cleaned).replaceAll("");
        cleaned = SCRIPT_TAG_PATTERN.matcher(cleaned).replaceAll("");

        // 2. Remove HTML comments
        cleaned = COMMENT_PATTERN.matcher(cleaned).replaceAll("");

        // 3. Remove sound tags
        cleaned = SOUND_TAG_PATTERN.matcher(cleaned).replaceAll("");

        // 4. Remove all remaining HTML tags
        cleaned = HTML_TAG_PATTERN.matcher(cleaned).replaceAll(" ");

        // 5. Unescape HTML entities (&nbsp;, &quot;, &#39;, &amp;, etc.)
        cleaned = HtmlUtils.htmlUnescape(cleaned);

        // 6. Replace non-breaking spaces (\u00A0) with standard spaces
        cleaned = cleaned.replace('\u00A0', ' ');

        // 7. Normalize whitespace and trim
        cleaned = WHITESPACE_PATTERN.matcher(cleaned).replaceAll(" ").trim();

        return cleaned;
    }

    /**
     * Safely bounds a string to maxLen characters without exceeding database varchar limits.
     */
    public static String boundString(String s, int maxLen) {
        if (s == null) {
            return null;
        }
        if (s.length() <= maxLen) {
            return s;
        }
        if (maxLen <= 3) {
            return s.substring(0, maxLen);
        }
        // Truncate cleanly with ellipsis
        return s.substring(0, maxLen - 3).trim() + "...";
    }
}
