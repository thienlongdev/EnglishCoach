package com.englishcoach.speaking.topic;

import com.englishcoach.speaking.topic.TopicBank.Band;
import com.englishcoach.speaking.topic.TopicBank.Item;
import com.englishcoach.speaking.topic.TopicBank.Style;
import com.englishcoach.speaking.topic.TopicDtos.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.*;

/**
 * "Nói theo chủ đề": draws curated English questions for one learner and records honest practice facts (drawn, skipped,
 * timer started, round finished with measured time). No AI, no transcription, no scoring, no audio on the server.
 */
@Service
public class TopicService {

    static final int DRAWS_PER_MINUTE = 40;
    private static final int RECENT_ROUNDS = 12;

    private final TopicBank bank;
    private final TopicRepository repository;
    private final Random random;
    private volatile Catalog catalog;

    @Autowired
    public TopicService(TopicBank bank, TopicRepository repository) {
        this(bank, repository, new SecureRandom());
    }

    TopicService(TopicBank bank, TopicRepository repository, Random random) {
        this.bank = bank;
        this.repository = repository;
        this.random = random;
    }

    public Catalog catalog() {
        Catalog c = catalog;
        if (c == null) {
            List<StyleCatalog> styles = new ArrayList<>();
            for (Style style : Style.values()) {
                List<Item> items = bank.items(style);
                List<CategoryCount> cats = new ArrayList<>();
                for (TopicBank.Category cat : bank.categories()) {
                    int n = (int) items.stream().filter(i -> i.category().equals(cat.key())).count();
                    if (n > 0) cats.add(new CategoryCount(cat.key(), cat.vi(), cat.en(), n));
                }
                Map<String, Integer> bands = new LinkedHashMap<>();
                for (Band b : Band.values()) bands.put(b.name(), (int) items.stream().filter(i -> i.band() == b).count());
                int questions = items.stream().mapToInt(i -> i.questions().size()).sum();
                styles.add(new StyleCatalog(style.name(), items.size(), questions, List.copyOf(cats), bands));
            }
            c = new Catalog(bank.version(), bank.provenance(), bank.reviewStatus(), List.copyOf(styles));
            catalog = c;
        }
        return c;
    }

    public ItemView item(String itemId) {
        return bank.item(itemId).map(this::view).orElseThrow(() -> new TopicException(404, "ITEM_NOT_FOUND"));
    }

    @Transactional
    public DrawResponse draw(long userId, DrawRequest request) {
        Item replay = null;
        Style style;
        if (request.replayItemId() != null) {
            replay = bank.item(request.replayItemId()).orElseThrow(() -> new TopicException(404, "ITEM_NOT_FOUND"));
            style = replay.style();
        } else {
            if (request.style() == null) throw new TopicException(400, "STYLE_REQUIRED");
            style = Style.valueOf(request.style());
        }
        String category = request.category();
        if (category != null && bank.category(category).isEmpty()) throw new TopicException(400, "UNKNOWN_CATEGORY");
        Band band = request.band() == null || !(style == Style.QUICK || style == Style.DEEP) ? null : Band.valueOf(request.band());

        repository.lockOwner(userId);
        List<TopicRepository.Draw> recent = repository.recent(userId, TopicRepository.HISTORY_WINDOW);
        for (TopicRepository.Draw d : recent) {
            if (d.requestId().equals(request.requestId())) {
                // the same command again (retry after a lost response): answer what it already produced
                Item item = bank.item(d.itemId()).orElseThrow(() -> new TopicException(409, "REQUEST_REUSED"));
                return new DrawResponse("DRAWN", d.id(), view(item), 0, 0);
            }
        }
        Instant minuteAgo = Instant.now().minusSeconds(60);
        if (recent.stream().filter(d -> d.drawnAt().isAfter(minuteAgo)).count() >= DRAWS_PER_MINUTE) {
            throw new TopicException(429, "TOO_MANY_DRAWS");
        }
        if (request.previousDrawId() != null) repository.skip(userId, request.previousDrawId());

        Item chosen;
        int poolSize;
        int unseen;
        if (replay != null) {
            chosen = replay;
            poolSize = 1;
            unseen = 0;
        } else {
            List<Item> history = recent.stream().map(d -> bank.item(d.itemId())).flatMap(Optional::stream).toList();
            String exclude = recent.isEmpty() ? null : recent.getFirst().itemId();
            TopicSelector.Result result = TopicSelector.choose(bank.pool(style, category, band), history, exclude,
                    request.allowReplay(), random);
            if (result.outcome() != TopicSelector.Outcome.CHOSEN) {
                return new DrawResponse(result.outcome().name(), null, null, result.poolSize(), 0);
            }
            chosen = result.item();
            poolSize = result.poolSize();
            unseen = result.unseen();
        }
        long id = repository.insert(userId, request.requestId(), chosen.id(), style.name(), bank.version(),
                replay != null ? "REPLAY" : "SPIN");
        return new DrawResponse("DRAWN", id, view(chosen), poolSize, unseen);
    }

    public RoundView start(long userId, long drawId, StartRequest request) {
        String status = repository.start(userId, drawId, request.targetSeconds());
        if (status == null) throw new TopicException(404, "DRAW_NOT_FOUND");
        if (!status.equals("STARTED")) throw new TopicException(409, "DRAW_NOT_STARTABLE");
        return new RoundView(drawId, status, request.targetSeconds(), null, null, false);
    }

    public RoundView finish(long userId, long drawId, FinishRequest request) {
        TopicRepository.Draw d = repository.finish(userId, drawId, request.spokenSeconds(), request.recorded());
        if (d == null) throw new TopicException(404, "DRAW_NOT_FOUND");
        if (!d.status().equals("FINISHED")) throw new TopicException(409, "ROUND_NOT_STARTED");
        return new RoundView(d.id(), d.status(), d.targetSeconds(), d.spokenSeconds(), d.reachedTarget(), d.recorded());
    }

    public Summary summary(long userId) {
        TopicRepository.Stats s = repository.stats(userId);
        List<HistoryEntry> recent = new ArrayList<>();
        for (TopicRepository.Draw d : repository.recentRounds(userId, RECENT_ROUNDS)) {
            bank.item(d.itemId()).ifPresent(item -> recent.add(new HistoryEntry(d.id(), d.status(), d.spokenSeconds(),
                    d.reachedTarget(), d.drawnAt(), view(item))));
        }
        List<ItemView> favorites = repository.favorites(userId).stream()
                .map(bank::item).flatMap(Optional::stream).map(this::view).toList();
        return new Summary(s.finished(), s.reachedTarget(), s.spokenSeconds(), s.distinctSpoken(), s.drawn(),
                s.lastPracticeAt(), List.copyOf(recent), favorites);
    }

    public void favorite(long userId, String itemId, boolean on) {
        if (bank.item(itemId).isEmpty()) throw new TopicException(404, "ITEM_NOT_FOUND");
        if (on) {
            if (!repository.addFavorite(userId, itemId)) throw new TopicException(409, "FAVORITE_LIMIT");
        } else {
            repository.removeFavorite(userId, itemId);
        }
    }

    ItemView view(Item i) {
        TopicBank.Category cat = bank.category(i.category()).orElseThrow();
        DefinitionView def = i.definition() == null ? null
                : new DefinitionView(i.definition().term(), i.definition().en(), i.definition().vi());
        return new ItemView(i.id(), i.style().name(), i.category(), cat.vi(), cat.en(), i.level(), i.band().name(),
                i.title(), i.questions(), i.bullets(), i.explain(), def, i.linkedId(), bank.followUp(i.id()).orElse(null));
    }
}
