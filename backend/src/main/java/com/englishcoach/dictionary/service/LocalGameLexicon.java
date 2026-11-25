package com.englishcoach.dictionary.service;

import com.englishcoach.dictionary.provider.KaikkiLocalLexicalStore;
import com.englishcoach.dictionary.provider.LocalEnViLexicalProvider;
import org.springframework.stereotype.Service;
import java.util.*;

/** Read-only gameplay adapter inside Dictionary. Never invokes the provider chain. */
@Service
public class LocalGameLexicon {
    public record Word(String normalizedWord, String displayWord, String ipa, String partOfSpeech,
                       String meaningVi, String cefr) {}
    private static final Set<String> POS = Set.of("N", "V", "A", "D", "C", "P", "E",
            "noun", "verb", "adj", "adv", "pron", "n");
    private final LocalEnViLexicalProvider local;
    private final KaikkiLocalLexicalStore kaikki;
    static final int CONQUEST_CACHE_CAP=3000;
    static final long CONQUEST_CACHE_TTL_NANOS=900_000_000_000L;
    private final java.util.function.LongSupplier nanoTime;
    private record Eligibility(Optional<Word> value,long at) {}
    private final Map<String,Eligibility> conquestCache=new LinkedHashMap<>(128,.75f,true){
        protected boolean removeEldestEntry(Map.Entry<String,Eligibility> entry){return size()>CONQUEST_CACHE_CAP;}
    };
    // Access ordered, synchronized, capacity bounded. Corpus is immutable until process restart.
    private final Map<String, Optional<Word>> cache = new LinkedHashMap<>(128, .75f, true) {
        protected boolean removeEldestEntry(Map.Entry<String, Optional<Word>> e) { return size() > 3000; }
    };
    @org.springframework.beans.factory.annotation.Autowired
    public LocalGameLexicon(LocalEnViLexicalProvider local, KaikkiLocalLexicalStore kaikki) {
        this(local,kaikki,System::nanoTime);
    }
    LocalGameLexicon(LocalEnViLexicalProvider local, KaikkiLocalLexicalStore kaikki,java.util.function.LongSupplier nanoTime) {
        this.local = local; this.kaikki = kaikki;this.nanoTime=nanoTime;
    }
    public boolean available() { return local.isAvailable(); }
    public List<String> candidateKeys() { return local.localWordKeys(); }
    /** King board words are ASCII, unambiguous ordinary entries; Word Chain policy is unchanged. */
    public synchronized Optional<Word> lookupConquest(String word) {
        if (word == null || !word.matches("[a-z]{3,8}")) return Optional.empty();
        long now=nanoTime.getAsLong();var cached=conquestCache.get(word);
        if(cached!=null&&now-cached.at()<CONQUEST_CACHE_TTL_NANOS)return cached.value();
        conquestCache.remove(word);
        var entry=local.lookupExactLocal(word);
        if (entry.isEmpty() || entry.get().getDefinitions().stream().anyMatch(d ->
                isProperName(d.getPos(), d.getSubPos(), d.getDefinition()))) {
            conquestCache.put(word,new Eligibility(Optional.empty(),now));return Optional.empty();
        }
        var result=lookup(word);conquestCache.put(word,new Eligibility(result,now));return result;
    }
    public static boolean isProperName(String pos,String subPos,String definition) {
        String metadata=(Objects.toString(pos, "")+" "+Objects.toString(subPos, "")).toLowerCase(Locale.ROOT);
        String meaning=Objects.toString(definition, "").strip().toLowerCase(Locale.ROOT);
        return metadata.matches(".*(proper|riêng).*" ) || meaning.matches(
            "^(thủ đô|thành phố|tỉnh của|tên riêng|danh từ riêng|tên (người|nước|một|gọi)|chòm sao|thần |nữ thần ).*");
    }
    public synchronized Optional<Word> lookup(String word) {
        if (cache.containsKey(word)) return cache.get(word);
        Optional<Word> result = local.lookupExactLocal(word).flatMap(entry -> entry.getDefinitions().stream()
                .filter(d -> POS.contains(Objects.toString(d.getPos(), "")))
                .filter(d -> d.getDefinition() != null && !d.getDefinition().isBlank())
                .filter(d -> !d.getDefinition().matches("(?iu)(nội động từ|ngoại động từ|danh từ|động từ|tính từ|trạng từ|liên từ|giới từ)\\.?"))
                .findFirst().map(d -> new Word(word, word, null, d.getPos(), d.getDefinition(), null)));
        var core = kaikki.getEntry(word);
        if (core.isPresent() && "WORD".equals(core.get().getEntryType()) && core.get().getPartsOfSpeech() != null) {
            var e = core.get();
            var pos = e.getPartsOfSpeech().stream().filter(p -> POS.contains(p.getPartOfSpeech())
                    || "interjection".equals(p.getPartOfSpeech())).findFirst();
            if (pos.isPresent()) {
                String ipa = e.getPronunciations() == null || e.getPronunciations().isEmpty()
                        ? null : e.getPronunciations().getFirst().getIpa();
                result = Optional.of(new Word(word, word, ipa, pos.get().getPartOfSpeech(),
                        e.getGeneralTranslationVi(), e.getCefr()));
            }
        }
        cache.put(word, result);
        return result;
    }
}
