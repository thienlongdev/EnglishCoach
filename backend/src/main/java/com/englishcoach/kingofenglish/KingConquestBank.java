package com.englishcoach.kingofenglish;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Offline-qualified boards, shared once. Runtime never solves the corpus on room creation. */
@Component
public final class KingConquestBank {
    public record Candidate(String word,List<Integer> path){public Candidate{path=path==null?List.of():List.copyOf(path);}}
    public record Quality(int playableWords,int shortWords,int longWords,int throneWords,int minCellCoverage,List<Integer> cellCoverage){
        public Quality{cellCoverage=cellCoverage==null?List.of():List.copyOf(cellCoverage);}
    }
    public record Board(String id,List<String> letters,long seed,Quality qualityMetrics,List<Candidate> echoCandidates,
        String sourceKind,String sourceRef,String contentVersion,String reviewStatus,String humanReview,String fingerprint){
        public Board{letters=letters==null?List.of():List.copyOf(letters);echoCandidates=echoCandidates==null?List.of():List.copyOf(echoCandidates);}
    }
    private final Map<String,Board> boards;
    private final KingCorpus corpus;
    KingCorpus corpus(){return corpus;}
    @org.springframework.beans.factory.annotation.Autowired
    public KingConquestBank(KingCorpus corpus){this.corpus=corpus;this.boards=corpus.artifactBacked()?Map.of():new KingConquestBank().boards;}
    public KingConquestBank(){
        corpus=null;
        try(var stream=getClass().getResourceAsStream("/data/king/conquest-engineering.json")){
            if(stream==null)throw new IllegalStateException("Missing Conquest boards");
            var data=List.of(new ObjectMapper().readValue(stream,Board[].class));
            var errors=validate(data);if(!errors.isEmpty())throw new IllegalStateException("Invalid Conquest boards: "+errors);
            var map=new LinkedHashMap<String,Board>();data.forEach(b->map.put(b.id(),b));boards=Collections.unmodifiableMap(map);
        }catch(java.io.IOException e){throw new IllegalStateException("Conquest boards unavailable",e);}
    }
    public Board get(String id){return corpus!=null&&corpus.artifactBacked()?corpus.board(id):boards.get(id);}
    public Collection<Board> all(){return corpus!=null&&corpus.artifactBacked()?corpus.entries("CONQUEST").stream().map(e->corpus.board(e.id())).toList():boards.values();}
    public String select(long seed){if(corpus!=null&&corpus.artifactBacked())return corpus.sequence("CONQUEST",0,1,seed).getFirst();var ids=new ArrayList<>(boards.keySet());return ids.get(new Random(seed).nextInt(ids.size()));}
    public static String fingerprint(Board b){
        try{
            String text=String.join("|",b.id(),String.join("",b.letters()),String.valueOf(b.seed()),b.sourceKind(),b.sourceRef(),b.contentVersion(),
                new ObjectMapper().writeValueAsString(b.qualityMetrics()),String.join("|",b.echoCandidates().stream().map(c->c.word()+":"+String.join(",",c.path().stream().map(String::valueOf).toList())).toList()));
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        }catch(Exception e){throw new IllegalArgumentException("Invalid board fingerprint fields",e);}
    }
    public static List<String> validate(List<Board> data){
        var errors=new ArrayList<String>();var ids=new HashSet<String>();var layouts=new HashSet<String>();
        for(var b:data){
            String p=Objects.toString(b.id(),"?")+":";
            if(b.id()==null||b.id().isBlank()||!ids.add(b.id()))errors.add(p+"INVALID_ID");
            if(b.letters().size()!=25||b.letters().stream().anyMatch(l->!l.matches("[A-Z]")))errors.add(p+"INVALID_LETTERS");
            if(!layouts.add(String.join("",b.letters())))errors.add(p+"DUPLICATE_BOARD");
            var m=b.qualityMetrics();
            if(m==null||m.playableWords()<50||m.shortWords()<20||m.longWords()<8||m.throneWords()<8||m.minCellCoverage()<2||m.cellCoverage().size()!=25||m.cellCoverage().stream().anyMatch(n->n<2))errors.add(p+"DEAD_BOARD");
            if(b.echoCandidates().size()<24||b.echoCandidates().size()>32||new HashSet<>(b.echoCandidates().stream().map(Candidate::word).toList()).size()!=b.echoCandidates().size())errors.add(p+"INVALID_CANDIDATES");
            for(var c:b.echoCandidates())try{KingConquestRules.path(b.letters(),c.word(),c.path());}catch(KingService.Rejection e){errors.add(p+"INVALID_PATH");}
            if(!"OFFLINE_GENERATED_ENGINEERING_BOARD".equals(b.sourceKind())||b.sourceRef()==null||b.sourceRef().isBlank()||b.contentVersion()==null||b.contentVersion().isBlank())errors.add(p+"MISSING_PROVENANCE");
            if(!"AUTO_VALIDATED".equals(b.reviewStatus())||b.humanReview()!=null)errors.add(p+"FAKE_APPROVAL");
            if(!fingerprint(b).equals(b.fingerprint()))errors.add(p+"STALE_FINGERPRINT");
        }return List.copyOf(errors);
    }
}
