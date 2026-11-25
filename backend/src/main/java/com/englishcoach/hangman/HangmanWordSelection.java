package com.englishcoach.hangman;

import java.util.*;
import java.util.random.RandomGenerator;
import java.time.Instant;

/** A progression slot owns its unlock rules, while a round snapshots an approved
 * word. History is newest first across the owner's tracks; the replaced round is
 * excluded even when it was started before many rounds on another track. */
final class HangmanWordSelection {
    static final int RECENT_WINDOW = 32;
    record Encounter(String answer,Instant lastSeen) {}

    static HangmanCatalog.Level select(List<HangmanCatalog.Level> pool, HangmanCatalog.Level slot,
                                      List<Encounter> history, RandomGenerator random) {
        return select(pool, slot, history, random, null);
    }
    static HangmanCatalog.Level select(List<HangmanCatalog.Level> pool, HangmanCatalog.Level slot,
                                      List<Encounter> history, RandomGenerator random, String replacedAnswer) {
        String previous = history.isEmpty() ? null : history.getFirst().answer();
        var seen=new HashMap<String,Instant>();history.forEach(e->seen.put(e.answer(),e.lastSeen()));
        var alternatives = pool.stream().filter(word -> word.difficulty() == slot.difficulty())
                .filter(word -> !word.answer().equals(previous)).toList();
        alternatives = alternatives.stream().filter(word -> !word.answer().equals(replacedAnswer)).toList();
        if (alternatives.isEmpty()) throw new HangmanException(409, "WORD_POOL_EXHAUSTED");

        var fresh = alternatives.stream().filter(word -> !seen.containsKey(word.answer())).toList();
        var candidates = fresh.isEmpty() ? alternatives : fresh;
        if (fresh.isEmpty()) {
            var recent=history.stream().limit(RECENT_WINDOW).map(Encounter::answer).collect(java.util.stream.Collectors.toSet());
            var outsideRecent=candidates.stream().filter(w->!recent.contains(w.answer())).toList();
            if(!outsideRecent.isEmpty())candidates=outsideRecent;
            // Randomize within a bounded least-recent band (oldest 10%, at most
            // 32 words), avoiding a predictable fixed cycle after exhaustion.
            var ordered=candidates.stream().sorted(Comparator.comparing(w->seen.get(w.answer()))).toList();
            int band=Math.min(ordered.size(),Math.max(1,Math.min(32,(alternatives.size()+9)/10)));
            Instant cutoff=seen.get(ordered.get(band-1).answer());
            candidates=ordered.stream().filter(w->!seen.get(w.answer()).isAfter(cutoff)).toList();
        }
        // Equal-weight category/spelling buckets, weighted against recent uses.
        // Never trade away lifetime unseen priority merely to match a slot category.
        var byAnswer=new HashMap<String,HangmanCatalog.Level>();pool.forEach(w->byAnswer.put(w.answer(),w));
        var recentUse=new HashMap<String,Integer>();
        history.stream().limit(RECENT_WINDOW).map(e->byAnswer.get(e.answer())).filter(Objects::nonNull).forEach(w->recentUse.merge(bucket(w),1,Integer::sum));
        var buckets=new TreeMap<String,List<HangmanCatalog.Level>>();
        for(var word:candidates)buckets.computeIfAbsent(bucket(word),k->new ArrayList<>()).add(word);
        int least=buckets.keySet().stream().mapToInt(k->recentUse.getOrDefault(k,0)).min().orElse(0);
        var balanced=buckets.keySet().stream().filter(k->recentUse.getOrDefault(k,0)==least).toList();
        var chosen=buckets.get(balanced.get(random.nextInt(balanced.size())));
        var selected = chosen.get(random.nextInt(chosen.size()));
        return new HangmanCatalog.Level(slot.difficulty(), slot.levelNumber(), selected.answer(),
                selected.category(), selected.answerVersion(), selected.sourceRef());
    }
    private static String bucket(HangmanCatalog.Level word){return word.category()+":"+(word.answer().length()<=6?"SHORT":"LONG")+":"+(word.answer().chars().distinct().count()<=5?"REPEATED":"VARIED");}

    private HangmanWordSelection() {}
}
