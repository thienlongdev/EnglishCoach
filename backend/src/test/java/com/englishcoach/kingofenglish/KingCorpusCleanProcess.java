package com.englishcoach.kingofenglish;

import java.nio.file.*;
import com.fasterxml.jackson.databind.ObjectMapper;

/** Standalone artifact-only process, intentionally outside the repository working directory. */
public final class KingCorpusCleanProcess {
    public static void main(String[] args)throws Exception{
        if(Files.exists(Path.of(".cache/king-corpus"))||Files.exists(Path.of("normalized.sqlite")))throw new IllegalStateException("Clean fixture contains a working corpus");
        try(var corpus=new KingCorpus("REVIEW_PREVIEW")){
            var reorder=corpus.challenge(corpus.entries("REORDER").getFirst().id());
            var reflex=corpus.challenge(corpus.entries("REFLEX").getFirst().id());
            var explain=corpus.explain(corpus.entries("EXPLAIN").getFirst().id());
            var board=corpus.board(corpus.entries("CONQUEST").getFirst().id());
            if(reorder.tokens().isEmpty()||reflex.canonical().isBlank()||explain.progressiveClues().size()!=3||board.letters().size()!=25)throw new IllegalStateException("Artifact provider unavailable");
            for(var candidate:board.echoCandidates())if(!corpus.wordEligible(candidate.word()))throw new IllegalStateException("Artifact lexicon unavailable");
            System.out.println(new ObjectMapper().writeValueAsString(java.util.Map.of("passResult",true,"workingDirectory",System.getProperty("user.dir"),"rawCorpusInWorkingDirectory",false,"workingDbInWorkingDirectory",false,"internetRequired",false,"providerCounts",corpus.counts())));
        }
    }
}
