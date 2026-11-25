package com.englishcoach.ai.echo;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.dto.EchoPageContextDto;
import com.englishcoach.ai.dto.EchoSalientResourceDto;
import com.englishcoach.ai.echo.camel.TurnProvenance;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * State of one Echo turn, owned by one thread. The learner id comes from the authenticated principal only; tools read it
 * from here and never from model arguments. Cards and actions are bounded so a looping model cannot flood the client.
 */
public final class EchoTurn {
    public static final int MAX_CARDS = 3, MAX_ACTIONS = 4, MAX_TOOL_CALLS = 6;

    private final long userId;
    private final boolean vi;
    private final boolean voice;
    private final String userText;
    private final EchoPageContextDto page;
    private final TurnProvenance provenance;
    private final Consumer<String> status;
    private final List<EchoCard> cards = new ArrayList<>();
    private final List<EchoAction> actions = new ArrayList<>();
    private int toolCalls;

    public EchoTurn(long userId, boolean vi, boolean voice, String userText, EchoPageContextDto page, Consumer<String> status) {
        this(userId, vi, voice, userText, page, List.of(), status);
    }

    public EchoTurn(long userId, boolean vi, boolean voice, String userText, EchoPageContextDto page,
                    List<EchoSalientResourceDto> salientResources, Consumer<String> status) {
        this.userId = userId;
        this.vi = vi;
        this.voice = voice;
        this.userText = userText == null ? "" : userText;
        this.page = page;
        this.provenance = TurnProvenance.analyze(this.userText, salientResources);
        this.status = status == null ? s -> {} : status;
    }

    public long userId() { return userId; }
    public boolean vi() { return vi; }
    public boolean voice() { return voice; }
    /** The learner's own latest message: the only text allowed to authorise an automatic navigation or a memory write. */
    public String userText() { return userText; }
    public EchoPageContextDto page() { return page; }
    public TurnProvenance provenance() { return provenance; }
    public List<EchoSalientResourceDto> salientResources() { return provenance.salientResources(); }
    public void authorizeResourceHref(String href) { provenance.authorizeResourceHref(href); }

    public void status(String text) {
        try { status.accept(text); }
        catch (java.util.concurrent.CancellationException cancelled) { throw cancelled; }
        catch (RuntimeException ignored) { /* a closed stream never breaks the turn */ }
    }

    public String t(String vi, String en) { return this.vi ? vi : en; }

    public synchronized void card(EchoCard card) { if (card != null && cards.size() < MAX_CARDS) cards.add(card); }
    public synchronized void action(EchoAction action) {
        if (action == null || actions.size() >= MAX_ACTIONS) return;
        if (action.href() != null) {
            if (actions.stream().anyMatch(a -> action.href().equals(a.href()))) return;
            actions.add(action);
            return;
        }
        if ("client_intent".equals(action.type()) && action.intent() != null && !action.intent().isEmpty()) {
            if (actions.stream().anyMatch(a -> "client_intent".equals(a.type()) && action.intent().equals(a.intent()))) return;
            actions.add(action);
        }
    }
    public synchronized List<EchoCard> cards() { return List.copyOf(cards); }
    public synchronized List<EchoAction> actions() { return List.copyOf(actions); }
    public synchronized boolean hasNavigateAction() { return actions.stream().anyMatch(a -> "navigate".equals(a.type())); }
    synchronized boolean spendToolCall() { return ++toolCalls <= MAX_TOOL_CALLS; }
    public synchronized int toolCalls() { return Math.min(toolCalls, MAX_TOOL_CALLS); }
}
