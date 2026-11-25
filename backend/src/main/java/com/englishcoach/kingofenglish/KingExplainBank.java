package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;

/** Immutable authored targets. Presentation must be projected by role, never serialize Item. */
@Component
public final class KingExplainBank {
    public record Item(String id,String target,List<String> acceptedAliases,List<String> progressiveClues,
        List<String> forbiddenForms,String meaning,String category,int difficulty,String cefr,
        String sourceKind,String sourceRef,String contentVersion,String fingerprint,String reviewStatus,String humanReview){
        public Item {
            acceptedAliases=acceptedAliases==null?List.of():List.copyOf(acceptedAliases);
            progressiveClues=progressiveClues==null?List.of():List.copyOf(progressiveClues);
            forbiddenForms=forbiddenForms==null?List.of():List.copyOf(forbiddenForms);
        }
    }
    private final Map<String,Item> items;
    private final KingCorpus corpus;
    @org.springframework.beans.factory.annotation.Autowired
    public KingExplainBank(KingCorpus corpus){this.corpus=corpus;this.items=corpus.artifactBacked()?Map.of():new KingExplainBank().items;}
    public KingExplainBank(){
        corpus=null;
        try(var stream=getClass().getResourceAsStream("/data/king/explain-engineering.json")){
            if(stream==null)throw new IllegalStateException("Missing Explain engineering bank");
            var data=List.of(new ObjectMapper().readValue(stream,Item[].class));
            var errors=validate(data);if(!errors.isEmpty())throw new IllegalStateException("Invalid Explain bank: "+errors);
            var map=new LinkedHashMap<String,Item>();data.forEach(i->map.put(i.id(),i));items=Collections.unmodifiableMap(map);
        }catch(java.io.IOException e){throw new IllegalStateException("Explain bank unavailable",e);}
    }
    public Item get(String id){return corpus!=null&&corpus.artifactBacked()?corpus.explain(id):items.get(id);}
    public Collection<Item> all(){return corpus!=null&&corpus.artifactBacked()?corpus.entries("EXPLAIN").stream().map(e->corpus.explain(e.id())).toList():items.values();}
    public List<String> sequence(int difficulty,int count,long seed,boolean human){
        if(corpus!=null&&corpus.artifactBacked()){
            var ids=corpus.sequence("EXPLAIN",difficulty,count,seed);return human?List.copyOf(ids.subList(0,ids.size()-ids.size()%2)):ids;
        }
        var ids=new ArrayList<>(items.values().stream().filter(i->difficulty==0||i.difficulty()<=difficulty).map(Item::id).toList());
        Collections.shuffle(ids,new Random(seed));int size=Math.min(count,ids.size());if(human)size-=size%2;
        if(size==0)throw new KingService.Rejection("CONTENT_UNAVAILABLE");return List.copyOf(ids.subList(0,size));
    }
    public static String normalize(String text){return text==null?"":java.text.Normalizer.normalize(text,java.text.Normalizer.Form.NFKC)
        .strip().toLowerCase(Locale.ROOT).replace('’','\'').replaceAll("[.,!?]","").replaceAll("\\s+"," ");}
    public static boolean correct(Item i,String answer){String a=normalize(answer);return a.equals(normalize(i.target()))||i.acceptedAliases().stream().anyMatch(x->a.equals(normalize(x)));}
    public static boolean leaks(Item i,String clue){
        String text=java.text.Normalizer.normalize(clue,java.text.Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        var forms=new ArrayList<String>();forms.add(i.target());forms.addAll(i.acceptedAliases());forms.addAll(i.forbiddenForms());
        for(String form:forms){
            var letters=normalize(form).replaceAll("[^a-z]","");
            if(letters.isEmpty())continue;
            String pattern="(?<![a-z])"+String.join("[\\W_]*",letters.chars().mapToObj(c->Pattern.quote(String.valueOf((char)c))).toList())+"(?![a-z])";
            if(Pattern.compile(pattern).matcher(text).find())return true;
        }return false;
    }
    public static String fingerprint(Item i){
        String text=String.join("|",Objects.toString(i.id(),""),Objects.toString(i.target(),""),String.join("~",i.acceptedAliases()),
            String.join("~",i.progressiveClues()),String.join("~",i.forbiddenForms()),Objects.toString(i.meaning(),""),
            Objects.toString(i.category(),""),String.valueOf(i.difficulty()),Objects.toString(i.cefr(),""),
            Objects.toString(i.sourceKind(),""),Objects.toString(i.sourceRef(),""),Objects.toString(i.contentVersion(),""));
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));}
        catch(Exception e){throw new IllegalStateException(e);}
    }
    public static List<String> validate(List<Item> data){
        var errors=new ArrayList<String>();var ids=new HashSet<String>();var targets=new HashSet<String>();
        for(var i:data){
            String p=Objects.toString(i.id(),"?")+":";
            if(i.id()==null||i.id().isBlank()||!ids.add(i.id()))errors.add(p+"INVALID_ID");
            if(i.target()==null||!normalize(i.target()).matches("[a-z]+(?:[ '-][a-z]+)*")||!targets.add(normalize(i.target())))errors.add(p+"INVALID_TARGET");
            if(i.progressiveClues().size()!=3||new HashSet<>(i.progressiveClues()).size()!=3||i.progressiveClues().stream().anyMatch(c->c.isBlank()||c.length()>KingConfig.EXPLAIN_CLUE_MAX||leaks(i,c)||KingCluePolicy.violation(c)!=null))errors.add(p+"INVALID_CLUES");
            var forms=new HashSet<String>();forms.add(normalize(i.target()));
            if(i.acceptedAliases().stream().anyMatch(a->a.isBlank()||!a.equals(normalize(a))||!forms.add(a)))errors.add(p+"INVALID_ALIAS");
            if(i.forbiddenForms().stream().anyMatch(a->a.isBlank()||!a.equals(normalize(a)))||new HashSet<>(i.forbiddenForms()).size()!=i.forbiddenForms().size())errors.add(p+"INVALID_FORBIDDEN");
            if(i.meaning()==null||i.meaning().isBlank()||i.category()==null||i.category().isBlank())errors.add(p+"MISSING_MEANING_CATEGORY");
            if(i.difficulty()<1||i.difficulty()>5||!Set.of("A1","A2","B1","B2","C1","C2").contains(Objects.toString(i.cefr(),"")))errors.add(p+"INVALID_LEVEL");
            if(!"MANUALLY_AUTHORED_ENGINEERING_FIXTURE".equals(i.sourceKind())||i.sourceRef()==null||i.sourceRef().isBlank()||i.contentVersion()==null||i.contentVersion().isBlank())errors.add(p+"MISSING_PROVENANCE");
            if(!"AUTO_VALIDATED".equals(i.reviewStatus())||i.humanReview()!=null)errors.add(p+"FAKE_APPROVAL");
            if(!fingerprint(i).equals(i.fingerprint()))errors.add(p+"STALE_FINGERPRINT");
        }return List.copyOf(errors);
    }
}
