package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import java.util.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** One immutable, closed-answer engineering bank. Never serialize Item to competitive clients. */
@Component
public class KingBank {
    public record Item(String id,String mode,String family,String prompt,List<String> tokens,List<String> options,
        String canonical,List<String> accepted,String meaning,int difficulty,String cefr,String cefrBasis,
        String sourceKind,String sourceRef,String version,String status,String humanReview,String fingerprint,
        String expression,String context,List<String> relationSet,Integer missingIndex) {
        public Item { tokens=tokens==null?List.of():List.copyOf(tokens);options=options==null?List.of():List.copyOf(options);
            accepted=accepted==null?List.of():List.copyOf(accepted);relationSet=relationSet==null?List.of():List.copyOf(relationSet); }
    }
    public static final Set<String> REFLEX_TYPES=Set.of("LETTER_SCRAMBLE","MISSING_LETTER","SPELLING_CORRECTION","SPELLING_CHOICE",
        "WORD_FAMILY","PART_OF_SPEECH","SYNONYM","ANTONYM","COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","GRAMMAR_TRAP","FIXED_EXPRESSION");
    private final Map<String,Item> items;
    private final KingCorpus corpus;
    @org.springframework.beans.factory.annotation.Autowired
    public KingBank(KingCorpus corpus){this.corpus=corpus;this.items=corpus.artifactBacked()?Map.of():new KingBank().items;}
    public KingBank() {
        corpus=null;
        try(var stream=KingBank.class.getResourceAsStream("/data/king/engineering.json")) {
            if(stream==null) throw new IllegalStateException("Missing King engineering bank");
            var data=new ObjectMapper().readValue(stream,Item[].class);var map=new LinkedHashMap<String,Item>();
            var errors=validate(List.of(data));if(!errors.isEmpty())throw new IllegalStateException("Invalid King bank: "+errors);
            for(var i:data)map.put(i.id(),i);items=Collections.unmodifiableMap(map);
        }catch(java.io.IOException e){throw new IllegalStateException("King bank unavailable",e);}
    }
    public Item get(String id){return corpus!=null&&corpus.artifactBacked()?corpus.challenge(id):items.get(id);}
    public List<String> sequence(String mode,int difficulty,int count,long seed) {
        if(corpus!=null&&corpus.artifactBacked())return corpus.sequence(mode,difficulty,count,seed);
        return KingContentSelector.sequence(items.values(),mode,difficulty,count,seed);
    }

    public static String normalize(String s){return s==null?"":s.strip().toLowerCase(Locale.ROOT).replaceAll("[.,!?]","").replaceAll("\\s+"," ");}
    private static List<String> multiset(String s){return Arrays.stream(normalize(s).split(" ")).sorted().toList();}
    public static boolean correct(Item item,String answer,List<Integer> order) {
        String value=answer;
        if(item.mode().equals("REORDER")||item.family().equals("LETTER_SCRAMBLE")){
            if(order==null||order.size()!=item.tokens().size()||new HashSet<>(order).size()!=order.size()||
                order.stream().anyMatch(x->x==null||x<0||x>=item.tokens().size()))return false;
            value=String.join(item.mode().equals("REORDER")?" ":"",order.stream().map(item.tokens()::get).toList());
        }
        String normalized=normalize(value);
        return normalize(item.canonical()).equals(normalized)||item.accepted().stream().anyMatch(a->normalize(a).equals(normalized));
    }
    public static String fingerprint(Item i) {
        String s=String.join("|",Objects.toString(i.id(),""),Objects.toString(i.mode(),""),Objects.toString(i.family(),""),
            Objects.toString(i.prompt(),""),String.join("~",i.tokens()),String.join("~",i.options()),
            Objects.toString(i.canonical(),""),String.join("~",i.accepted()),Objects.toString(i.expression(),""),
            Objects.toString(i.context(),""),String.join("~",i.relationSet()),Objects.toString(i.missingIndex(),""));
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));}
        catch(Exception e){throw new IllegalStateException(e);}
    }
    public static List<String> validate(List<Item> bank){
        var errors=new ArrayList<String>();var ids=new HashSet<String>();var semantic=new HashSet<String>();
        for(var i:bank){
            String prefix=Objects.toString(i.id(),"?")+":";
            if(i.id()==null||i.id().isBlank()||!ids.add(i.id()))errors.add(prefix+"DUPLICATE_ID");
            if(!Set.of("REORDER","REFLEX").contains(Objects.toString(i.mode(),"")))errors.add(prefix+"INVALID_MODE");
            if(i.canonical()==null||normalize(i.canonical()).isBlank())errors.add(prefix+"EMPTY_ANSWER");
            if(!semantic.add(i.mode()+"|"+i.family()+"|"+normalize(i.prompt())))errors.add(prefix+"SEMANTIC_DUPLICATE");
            if(i.difficulty()<1||i.difficulty()>5||!Set.of("A1","A2","B1","B2","C1","C2").contains(Objects.toString(i.cefr(),"")))
                errors.add(prefix+"INVALID_LEVEL");
            if(!"MANUALLY_ESTIMATED".equals(i.cefrBasis())||!"MANUALLY_AUTHORED_ENGINEERING_FIXTURE".equals(i.sourceKind())||
                i.sourceRef()==null||i.sourceRef().isBlank()||i.version()==null||i.version().isBlank())errors.add(prefix+"MISSING_PROVENANCE");
            if(!Set.of("DRAFT","AUTO_VALIDATED","REVIEW_REQUIRED","APPROVED","ACTIVE","REJECTED").contains(Objects.toString(i.status(),"")))errors.add(prefix+"INVALID_STATUS");
            if(i.humanReview()!=null||Set.of("APPROVED","ACTIVE").contains(Objects.toString(i.status(),"")))errors.add(prefix+"FAKE_APPROVAL");
            if(!fingerprint(i).equals(i.fingerprint()))errors.add(prefix+"STALE_FINGERPRINT");
            var answers=new HashSet<String>();answers.add(normalize(i.canonical()));
            for(var a:i.accepted())if(a==null||normalize(a).isBlank()||!answers.add(normalize(a)))errors.add(prefix+"MALFORMED_ALTERNATIVE");
            if(i.meaning()==null||i.meaning().isBlank())errors.add(prefix+"MISSING_MEANING");
            if("REORDER".equals(i.mode())){
                if(i.tokens().size()<2||i.tokens().size()>24||!multiset(String.join(" ",i.tokens())).equals(multiset(i.canonical())))
                    errors.add(prefix+"BROKEN_TOKENS");
                for(var a:i.accepted())if(!multiset(a).equals(multiset(i.canonical())))errors.add(prefix+"FOREIGN_TOKENS");
            }else{
                if(!REFLEX_TYPES.contains(i.family()))errors.add(prefix+"INVALID_FAMILY");
                switch(Objects.toString(i.family(),"")){
                    case "LETTER_SCRAMBLE" -> {if(!String.join("",i.tokens()).chars().sorted().boxed().toList().equals(i.canonical().chars().sorted().boxed().toList()))errors.add(prefix+"BROKEN_TOKENS");}
                    case "MISSING_LETTER" -> {if(i.missingIndex()==null||i.missingIndex()<0||i.missingIndex()>=i.prompt().length()||
                        i.prompt().charAt(i.missingIndex())!='_'||i.canonical().length()!=1)errors.add(prefix+"INVALID_MISSING_INDEX");}
                    case "SPELLING_CORRECTION" -> {if(normalize(i.prompt()).equals(normalize(i.canonical())))errors.add(prefix+"INVALID_SPELLING");}
                    case "SPELLING_CHOICE" -> {if(i.options().size()<2||!i.options().contains(i.canonical())||new HashSet<>(i.options()).size()!=i.options().size())errors.add(prefix+"INVALID_CHOICES");}
                    case "SYNONYM","ANTONYM" -> {if(i.relationSet().isEmpty()||!i.relationSet().contains(i.canonical()))errors.add(prefix+"MISSING_RELATION");}
                    case "PART_OF_SPEECH" -> {if(!Set.of("noun","verb","adjective","adverb","pronoun","preposition","conjunction","determiner","interjection").contains(i.canonical())||i.context()==null||i.context().isBlank())errors.add(prefix+"INVALID_POS");}
                    case "COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION" -> {if(i.expression()==null||i.expression().isBlank())errors.add(prefix+"MISSING_EXPRESSION");}
                }
            }
        }return List.copyOf(errors);
    }
    public Map<String,Object> quality(){
        if(corpus!=null&&corpus.artifactBacked())return corpus.counts();
        return Map.of("TOTAL_UNIQUE",items.size(),"AUTO_VALID",items.values().stream().filter(i->i.status().equals("AUTO_VALIDATED")).count(),
            "REVIEW_REQUIRED",items.values().stream().filter(i->i.status().equals("REVIEW_REQUIRED")).count(),
            "REJECTED",0,"ACTIVE",0,"DUPLICATES",0,"BROKEN_TOKENS",0,"AMBIGUOUS_WITHOUT_REVIEW",0,"MISSING_PROVENANCE",0);
    }
    public Map<String,Object> presentation(String id,long seed,boolean resolved){
        var i=get(id);var out=new LinkedHashMap<String,Object>();
        out.put("id",i.id());out.put("mode",i.mode());out.put("family",i.family());out.put("prompt",i.prompt());
        out.put("options",i.options());out.put("difficulty",i.difficulty());out.put("context",i.context());
        if(corpus!=null&&corpus.artifactBacked()&&i.family().equals("PART_OF_SPEECH")){
            var content=corpus.get(id).path("content");out.put("occurrenceStart",content.path("occurrenceStart").asInt());out.put("occurrenceEnd",content.path("occurrenceEnd").asInt());
        }
        if(!i.tokens().isEmpty()){
            var order=new ArrayList<Integer>();for(int x=0;x<i.tokens().size();x++)order.add(x);
            Collections.shuffle(order,new Random(seed));
            if(correct(i,null,order)){
                boolean found=false;
                for(int a=0;a<order.size()&&!found;a++)for(int b=a+1;b<order.size()&&!found;b++){
                    Collections.swap(order,a,b);if(!correct(i,null,order))found=true;else Collections.swap(order,a,b);
                }
            }
            out.put("tiles",order.stream().map(x->Map.of("id",x,"text",i.tokens().get(x))).toList());
        }
        if(resolved){out.put("answer",i.canonical());out.put("meaning",i.meaning());}
        return out;
    }
}

