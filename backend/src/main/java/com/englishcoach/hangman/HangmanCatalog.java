package com.englishcoach.hangman;

import com.englishcoach.kingofenglish.KingCorpus;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import java.util.*;
import static com.englishcoach.hangman.HangmanRules.*;

@Component
public final class HangmanCatalog {
    public record Level(Difficulty difficulty,int levelNumber,String answer,String category,String answerVersion,String sourceRef) {}
    private final Map<Difficulty,List<Level>> tracks=new EnumMap<>(Difficulty.class);
    private final Map<Difficulty,List<Level>> pools=new EnumMap<>(Difficulty.class);
    private static final String VERSION="hangman-20261009-4";
    private final String version; private final int sourceEligibleCount;
    private final KingCorpus corpus;
    @Autowired
    public HangmanCatalog(ObjectMapper json,KingCorpus approvedKingCorpus){
        corpus=Objects.requireNonNull(approvedKingCorpus);version=VERSION;
        try(var input=HangmanCatalog.class.getResourceAsStream("/data/hangman/levels.json")){
            if(input==null)throw new IllegalStateException("Missing progression catalog");
            var root=json.readTree(input);String seedVersion=root.path("version").asText();
            if(!seedVersion.equals("hangman-20261008-1"))throw new IllegalStateException("Unknown progression catalog");
            var seeds=new TreeMap<String,Level>();
            for(Difficulty d:Difficulty.values()){tracks.put(d,new ArrayList<>());pools.put(d,new ArrayList<>());}
            for(var node:root.path("levels")){
                var level=json.treeToValue(node,Level.class);var track=tracks.get(level.difficulty());String key=level.answer().toLowerCase(Locale.ROOT);
                if(level.levelNumber()!=track.size()+1||seeds.put(key,level)!=null||distinctLetters(level.answer()).size()<=level.difficulty().prefill||!seedVersion.equals(level.answerVersion())||!Set.of("NATURE","ANIMALS","FOOD","PLACES","EVERYDAY","IDEAS").contains(level.category())||!level.sourceRef().equals("king-core.lexicon:"+key)||!corpus.wordEligible(key))throw new IllegalStateException("Invalid progression seed");
                track.add(level);
            }
            var vocabulary=corpus.vocabulary();sourceEligibleCount=vocabulary.size();
            for(var word:vocabulary){
                var seed=seeds.get(word.word());var difficulty=HangmanVocabulary.classify(word);
                // Editorial seeds supply missing familiarity metadata only. Known CEFR
                // takes precedence; the historical slot/unlock catalog never changes.
                if(difficulty==null&&seed!=null&&HangmanVocabulary.shape(word.word())&&!HangmanVocabulary.UNSUITABLE.contains(word.word()))difficulty=seed.difficulty();
                if(difficulty==null)continue;
                pools.get(difficulty).add(new Level(difficulty,1,word.word().toUpperCase(Locale.ROOT),seed==null?"VOCABULARY":seed.category(),version,"king-core.lexicon:"+word.word()));
            }
            for(Difficulty d:Difficulty.values()){
                if(tracks.get(d).isEmpty()||pools.get(d).size()<100)throw new IllegalStateException("Missing expanded difficulty pool");
                tracks.put(d,List.copyOf(tracks.get(d)));pools.put(d,List.copyOf(pools.get(d)));
            }
            if(pools.values().stream().mapToInt(List::size).sum()<1000)throw new IllegalStateException("Expanded vocabulary unavailable");
        }catch(Exception e){throw new IllegalStateException("Hangman catalog validation failed",e);}
    }
    public String version(){return version;} public int count(Difficulty d){return tracks.get(d).size();} public int sourceEligibleCount(){return sourceEligibleCount;} public Level level(Difficulty d,int n){if(n<1||n>count(d))throw new HangmanException(409,"LEVEL_UNAVAILABLE");return tracks.get(d).get(n-1);} public List<Level> levels(Difficulty d){return tracks.get(d);}
    public List<Level> pool(Difficulty d){if(!corpus.enabled())throw new HangmanException(503,"GAME_UNAVAILABLE");return pools.get(d);}
    public int eligibleCount(Difficulty d){return pool(d).size();}
}
