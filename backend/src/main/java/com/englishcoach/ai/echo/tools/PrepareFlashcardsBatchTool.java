package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.dto.EchoPageContextDto;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.englishcoach.reading.dto.BilingualReadingDetailResponse;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.BilingualReadingService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Tool #19 ({@code prepare_flashcards_batch}, {@link Kind#PREPARE}):
 * Prepares 1..8 vocabulary flashcards extracted from the current passage or explicitly requested by the learner,
 * returning a single-use {@link EchoConfirmations} confirmation card ({@code PREPARE -> PREVIEW -> CONFIRM -> COMMIT}).
 */
@Component
public class PrepareFlashcardsBatchTool implements EchoTool {

    private final EchoConfirmations confirmations;
    private final ObjectProvider<ReadingMaterialRepository> readingRepo;
    private final ObjectProvider<BilingualReadingService> bilingualReading;
    private final ObjectMapper mapper;

    /** Backward-compatible 3-arg constructor preserved for existing unit tests. */
    public PrepareFlashcardsBatchTool(EchoConfirmations confirmations,
                                      ObjectProvider<ReadingMaterialRepository> readingRepo,
                                      ObjectMapper mapper) {
        this(confirmations, readingRepo, null, mapper);
    }

    @Autowired
    public PrepareFlashcardsBatchTool(EchoConfirmations confirmations,
                                      ObjectProvider<ReadingMaterialRepository> readingRepo,
                                      @Autowired(required = false) ObjectProvider<BilingualReadingService> bilingualReading,
                                      ObjectMapper mapper) {
        this.confirmations = confirmations;
        this.readingRepo = readingRepo;
        this.bilingualReading = bilingualReading;
        this.mapper = mapper;
    }

    @Override
    public String name() {
        return "prepare_flashcards_batch";
    }

    @Override
    public String description() {
        return "Prepare (not immediately save) a batch of 1 to 8 vocabulary flashcards from the current reading passage or book excerpt "
                + "when the learner asks to create flashcards. Shows a Confirm / Cancel preview card; nothing is saved until the learner confirms.";
    }

    @Override
    public Map<String, Object> parameters() {
        Map<String, Object> cardProps = new LinkedHashMap<>();
        cardProps.put("front", EchoToolRegistry.str("English word or short phrase from the passage", 120));
        cardProps.put("back", EchoToolRegistry.str("Clear Vietnamese meaning or concise definition", 320));
        cardProps.put("example", EchoToolRegistry.str("Short natural English example sentence", 260));
        cardProps.put("ipa", EchoToolRegistry.str("Optional IPA pronunciation", 80));
        cardProps.put("cefr", EchoToolRegistry.enumOf("Optional CEFR level", List.of("A1", "A2", "B1", "B2", "C1", "C2")));
        cardProps.put("part_of_speech", EchoToolRegistry.str("Optional part of speech (noun, verb, adjective, idiom)", 32));

        Map<String, Object> itemSchema = EchoToolRegistry.schema(cardProps, List.of("front", "back"));
        Map<String, Object> cardsArray = new LinkedHashMap<>();
        cardsArray.put("type", "array");
        cardsArray.put("description", "Between 1 and 8 flashcards to prepare for learner confirmation");
        cardsArray.put("minItems", 1);
        cardsArray.put("maxItems", 8);
        cardsArray.put("items", itemSchema);

        Map<String, Object> props = new LinkedHashMap<>();
        props.put("cards", cardsArray);
        return EchoToolRegistry.schema(props, List.of("cards"));
    }

    @Override
    public Kind kind() {
        return Kind.PREPARE;
    }

    @Override
    public String status(boolean vi) {
        return vi ? "Echo đang chuẩn bị bộ thẻ từ vựng để bạn xác nhận…"
                : "Echo is preparing flashcards for you to confirm…";
    }

    @Override
    public String run(EchoTurn turn, JsonNode args) throws Exception {
        if (!CaMeLPolicyEngine.canSaveOrPrepareFlashcards(turn)) {
            return mapper.writeValueAsString(Map.of(
                    "prepared", false,
                    "reason", "learner_did_not_request_flashcards"));
        }

        JsonNode cardsNode = args.path("cards");
        if (!cardsNode.isArray() || cardsNode.isEmpty()) {
            return mapper.writeValueAsString(Map.of("prepared", false, "reason", "empty_cards"));
        }

        String groundingText = resolveGroundingText(turn);
        List<EchoConfirmations.FlashcardDraft> drafts = new ArrayList<>();
        Set<String> seenFronts = new LinkedHashSet<>();

        for (JsonNode c : cardsNode) {
            if (drafts.size() >= 8) break;
            String front = c.path("front").asText("").trim();
            String back = c.path("back").asText("").trim();
            if (front.isEmpty() || back.isEmpty()) continue;
            String normKey = front.toLowerCase(Locale.ROOT);
            if (!seenFronts.add(normKey)) continue;
            if (groundingText != null && !isGroundedInPassage(front, groundingText)) {
                continue;
            }
            String example = c.hasNonNull("example") ? c.get("example").asText("").trim() : null;
            String ipa = c.hasNonNull("ipa") ? c.get("ipa").asText("").trim() : null;
            String cefr = c.hasNonNull("cefr") ? c.get("cefr").asText("").trim() : null;
            String pos = c.hasNonNull("part_of_speech") ? c.get("part_of_speech").asText("").trim() : null;
            drafts.add(new EchoConfirmations.FlashcardDraft(front, back, example, ipa, cefr, pos));
        }

        if (drafts.isEmpty()) {
            return mapper.writeValueAsString(Map.of(
                    "prepared", false,
                    "reason", groundingText != null ? "not_grounded_in_passage" : "no_valid_cards"));
        }

        String token = confirmations.issue(turn.userId(), new EchoConfirmations.FlashcardBatchCommit(List.copyOf(drafts)));
        List<EchoCard.Item> rows = new ArrayList<>();
        for (EchoConfirmations.FlashcardDraft d : drafts) {
            String meta = d.cefr() != null && !d.cefr().isBlank() ? d.cefr()
                    : (d.partOfSpeech() != null && !d.partOfSpeech().isBlank() ? d.partOfSpeech() : null);
            rows.add(new EchoCard.Item(clip(d.front(), 60), clip(d.back(), 90), meta, null, null));
        }
        String title = turn.t("Tạo " + drafts.size() + " thẻ từ vựng", "Create " + drafts.size() + " flashcards");
        String note = turn.t(
                "Nhấn Xác nhận để lưu các thẻ này vào bộ thẻ cá nhân của bạn.",
                "Press Confirm to save these flashcards to your personal collection.");
        turn.card(new EchoCard("confirm", title, rows, token, note));

        return mapper.writeValueAsString(Map.of(
                "prepared", true,
                "count", drafts.size(),
                "requiresLearnerConfirmation", true));
    }

    private String resolveGroundingText(EchoTurn turn) {
        EchoPageContextDto page = turn.page();
        if (page == null) return null;
        StringBuilder sb = new StringBuilder();
        if (page.selection() != null && !page.selection().isBlank()) {
            sb.append(page.selection()).append(' ');
        }
        if ("READING_MATERIAL".equals(page.kind()) && page.id() != null) {
            // Security invariant: NEVER append untrusted clientVisibleExcerpt for server-owned reading materials!
            ReadingMaterialRepository repo = readingRepo == null ? null : readingRepo.getIfAvailable();
            if (repo != null) {
                repo.findByIdAndVisibleToUser(page.id(), turn.userId()).ifPresent(m -> {
                    if (m.getContentText() != null) sb.append(m.getContentText());
                });
            }
        } else if ("BILINGUAL_READING".equals(page.kind()) && page.id() != null) {
            BilingualReadingService biSvc = bilingualReading == null ? null : bilingualReading.getIfAvailable();
            if (biSvc != null) {
                try {
                    BilingualReadingDetailResponse detail = biSvc.detail(page.id());
                    if (detail != null && detail.segments() != null) {
                        for (BilingualReadingDetailResponse.Segment seg : detail.segments()) {
                            if (seg.en() != null) sb.append(seg.en()).append(' ');
                        }
                    }
                } catch (RuntimeException ignored) { }
            }
        } else if ("BOOK_EXCERPT".equals(page.kind()) || "BOOK_ACTIVE".equals(page.kind())) {
            if (page.clientVisibleExcerpt() != null && !page.clientVisibleExcerpt().isBlank()) {
                sb.append(page.clientVisibleExcerpt()).append(' ');
            }
            if (page.bookMeta() != null && page.bookMeta().recentHighlights() != null) {
                for (String hl : page.bookMeta().recentHighlights()) {
                    if (hl != null && !hl.isBlank()) sb.append(hl).append(' ');
                }
            }
        }
        String joined = sb.toString().toLowerCase(Locale.ROOT).trim();
        return joined.isEmpty() ? null : joined;
    }

    static boolean isGroundedInPassage(String front, String lowercasePassage) {
        String clean = front.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9' -]", " ").replaceAll("\\s+", " ").trim();
        if (clean.isEmpty()) return false;
        if (lowercasePassage.contains(clean)) return true;
        String[] tokens = clean.split(" ");
        for (String tok : tokens) {
            if (tok.length() < 4) continue;
            String stem = tok.length() >= 6 ? tok.substring(0, tok.length() - 2) : tok.substring(0, tok.length() - 1);
            if (lowercasePassage.contains(stem)) return true;
        }
        return false;
    }

    private static String clip(String s, int max) {
        return s == null ? "" : s.length() <= max ? s : s.substring(0, max - 1) + "\u2026";
    }
}
