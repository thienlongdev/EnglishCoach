package com.englishcoach.ai.echo.camel;

import com.englishcoach.ai.dto.EchoSalientResourceDto;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer;
import com.englishcoach.ai.echo.EchoSpeechActAnalyzer.UtteranceAnalysis;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * CaMeL Turn Provenance & Capability Token computed ONCE per {@code EchoTurn} exclusively from the learner's own
 * unquoted, non-negated, non-hypothetical, non-metalinguistic utterance clauses plus server-validated
 * {@link EchoSalientResourceDto} hrefs.
 *
 * <p>Security Invariant: Untrusted {@code pageContext} passages, book highlights, selected text, and tool outputs can
 * NEVER mint capabilities on {@link TurnProvenance}. Only {@link #authorizeResourceHref(String)} may add verified
 * catalog resource hrefs discovered by {@code Kind.READ} search tools during the turn.</p>
 */
public final class TurnProvenance {

    private static final Pattern FLASHCARD_SAVE_CUE_RE = Pattern.compile(
            "\\b(?:(?:create|make|build|generate|add|save|extract|prepare)\\s+(?:me\\s+)?(?:some\\s+|new\\s+)?(?:a\\s+)?(?:flashcards?|vocab(?:ulary)?\\s+cards?|cards?|words?)|flashcards?\\s+(?:from|for)|save\\s+(?:this|that|the)\\s+(?:word|phrase|idiom)|(?:tao|them|luu|trich\\s+xuat|chuan\\s+bi)\\s+(?:cac\\s+|nhung\\s+|mot\\s+so\\s+|giup\\s+(?:minh|toi|em)\\s+)?(?:the\\s+tu(?:\\s+vung)?|flashcards?|tu\\s+vung|tu\\s+kho|tu\\s+nay))\\b");

    private static final Pattern DECK_ENROLL_CUE_RE = Pattern.compile(
            "\\b(?:(?:enroll|join|add|start|subscribe|tham\\s+gia|them|dang\\s+ky|bat\\s+dau)\\s+(?:[a-z0-9]+\\s+){0,6}(?:decks?|bo\\s+the|kho\\s+tu))\\b");

    private static final Pattern MEMORY_CUE_RE = Pattern.compile(
            "\\b(?:nho\\s+(?:rang|la|giup|giu)|hay\\s+nho|ghi\\s+nho|tu\\s+(?:gio|nay|bay\\s+gio)(?:\\s+tro\\s+di)?|luon\\s+luon|remember\\s+(?:that|this|my|me|to|i\\b)|from\\s+now\\s+on|always|every\\s+time|in\\s+the\\s+future|keep\\s+in\\s+mind|luu\\s+(?:y|lai)\\s+(?:giup|cho)|minh\\s+(?:thich|muon)\\s+(?:ban|echo|duoc)|i\\s+prefer|i\\s+like\\s+(?:short|long|detailed)|toi\\s+thich|em\\s+thich)\\b");

    private static final Pattern WORKSPACE_CONTROL_CUE_RE = Pattern.compile(
            "\\b(?:switch|turn|enable|disable|set|change|increase|decrease|adjust|apply|reset|customize|brighten|darken|dim|filter|open|resume|continue|play|pause|stop|mute|unmute|replay|slow\\s+down|speed\\s+up|scroll|pin|hide|show|auto[-\\s]?hide|embed|immersive|fullscreen|floating|go\\s+back|back|look\\s+up|define|chuyen|bat|tat|doi|tang|giam|chinh|ap\\s+dung|dat\\s+lai|khoi\\s+phuc|tuy\\s+chinh|lam\\s+sang|lam\\s+toi|loc|mo|doc\\s+tiep|phat|tam\\s+dung|dung|nghe\\s+lai|nghe\\s+cham|nghe\\s+nhanh|cuon|keo|luot|ghim|an|hien|tu\\s+an|thu\\s+nho|tran\\s+vien|quay\\s+lai|tro\\s+lai|tra\\s+tu|tra\\s+cuu)\\b");

    private static final Pattern PLAN_CHANGE_CUE_RE = Pattern.compile(
            "\\b(?:plan|goal|target|path|schedule|minutes|daily|update|change|adjust|set|switch|propose|dna|ielts|toeic|lo\\s+trinh|muc\\s+tieu|ke\\s+hoach|lich\\s+hoc|phut|moi\\s+ngay|cap\\s+nhat|thay\\s+doi|dieu\\s+chinh|de\\s+xuat|doi)\\b");

    private final UtteranceAnalysis speechAct;
    private final String trustedClausesText;
    private final boolean hasOpenDirective;
    private final boolean hasFlashcardSaveCue;
    private final boolean hasDeckEnrollCue;
    private final boolean hasMemoryCue;
    private final boolean hasWorkspaceControlCue;
    private final boolean hasPlanChangeCue;
    private final List<EchoSalientResourceDto> salientResources;
    private final Set<String> authorizedResourceHrefs = Collections.synchronizedSet(new LinkedHashSet<>());

    private TurnProvenance(
            UtteranceAnalysis speechAct,
            String trustedClausesText,
            boolean hasOpenDirective,
            boolean hasFlashcardSaveCue,
            boolean hasDeckEnrollCue,
            boolean hasMemoryCue,
            boolean hasWorkspaceControlCue,
            boolean hasPlanChangeCue,
            List<EchoSalientResourceDto> salientResources
    ) {
        this.speechAct = speechAct;
        this.trustedClausesText = trustedClausesText;
        this.hasOpenDirective = hasOpenDirective;
        this.hasFlashcardSaveCue = hasFlashcardSaveCue;
        this.hasDeckEnrollCue = hasDeckEnrollCue;
        this.hasMemoryCue = hasMemoryCue;
        this.hasWorkspaceControlCue = hasWorkspaceControlCue;
        this.hasPlanChangeCue = hasPlanChangeCue;
        this.salientResources = salientResources;
        for (EchoSalientResourceDto r : salientResources) {
            if (r.href() != null && EchoDestinations.isAllowedHref(r.href())) {
                this.authorizedResourceHrefs.add(r.href().trim());
            }
        }
    }

    public static TurnProvenance analyze(String userText, List<EchoSalientResourceDto> rawSalient) {
        UtteranceAnalysis sa = EchoSpeechActAnalyzer.analyze(userText);
        String trusted = EchoSpeechActAnalyzer.activeTrustedClausesText(sa);
        List<EchoSalientResourceDto> validSalient = sanitizeSalientResources(rawSalient);

        boolean openDir = EchoSpeechActAnalyzer.hasAuthorizedOpenIntent(sa);
        boolean flashcardCue = !trusted.isEmpty() && FLASHCARD_SAVE_CUE_RE.matcher(trusted).find();
        boolean deckCue = !trusted.isEmpty() && DECK_ENROLL_CUE_RE.matcher(trusted).find();
        boolean memoryCue = !trusted.isEmpty() && MEMORY_CUE_RE.matcher(trusted).find();
        boolean controlCue = !trusted.isEmpty() && WORKSPACE_CONTROL_CUE_RE.matcher(trusted).find();
        boolean planCue = !trusted.isEmpty() && PLAN_CHANGE_CUE_RE.matcher(trusted).find();

        return new TurnProvenance(sa, trusted, openDir, flashcardCue, deckCue, memoryCue, controlCue, planCue, validSalient);
    }

    public static List<EchoSalientResourceDto> sanitizeSalientResources(List<EchoSalientResourceDto> raw) {
        if (raw == null || raw.isEmpty()) return List.of();
        List<EchoSalientResourceDto> out = new ArrayList<>();
        Set<String> seenHrefs = new LinkedHashSet<>();
        for (EchoSalientResourceDto item : raw) {
            if (item == null || item.href() == null) continue;
            String href = item.href().trim();
            if (!EchoDestinations.isAllowedHref(href) || !seenHrefs.add(href)) continue;
            String cleanTitle = item.title() == null ? "" : item.title().replaceAll("[\\p{Cc}\\p{Cf}]+", " ").replaceAll("\\s+", " ").trim();
            if (cleanTitle.length() > 140) cleanTitle = cleanTitle.substring(0, 140);
            String cleanKind = item.kind() == null ? "resource" : item.kind().replaceAll("[^A-Za-z0-9_-]", "");
            if (cleanKind.length() > 32) cleanKind = cleanKind.substring(0, 32);
            int cleanIdx = (item.index() >= 1 && item.index() <= 12) ? item.index() : (out.size() + 1);
            out.add(new EchoSalientResourceDto(cleanIdx, cleanTitle, href, cleanKind));
            if (out.size() >= 12) break;
        }
        return List.copyOf(out);
    }

    public UtteranceAnalysis speechAct() { return speechAct; }
    public String trustedClausesText() { return trustedClausesText; }
    public boolean hasOpenDirective() { return hasOpenDirective; }
    public boolean hasFlashcardSaveCue() { return hasFlashcardSaveCue; }
    public boolean hasDeckEnrollCue() { return hasDeckEnrollCue; }
    public boolean hasMemoryCue() { return hasMemoryCue; }
    public boolean hasWorkspaceControlCue() { return hasWorkspaceControlCue; }
    public boolean hasPlanChangeCue() { return hasPlanChangeCue; }
    public List<EchoSalientResourceDto> salientResources() { return salientResources; }

    public void authorizeResourceHref(String href) {
        if (href != null && EchoDestinations.isAllowedHref(href)) {
            authorizedResourceHrefs.add(href.trim());
        }
    }

    public boolean isResourceHrefAuthorized(String href) {
        return href != null && authorizedResourceHrefs.contains(href.trim());
    }

    public Set<String> authorizedResourceHrefs() {
        synchronized (authorizedResourceHrefs) {
            return Set.copyOf(authorizedResourceHrefs);
        }
    }
}
