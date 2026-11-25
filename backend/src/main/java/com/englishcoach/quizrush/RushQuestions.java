package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.*;
import org.springframework.stereotype.Component;
import java.util.*;
import java.text.Normalizer;
import static com.englishcoach.quizrush.RushDtos.*;

/**
 * Read-only adapter. No source scoring and no corpus copies. Closed-choice King items keep their own source choices;
 * typed-answer King items join only through a provable closed choice (see {@link #derivedChoices}): a spelling item
 * pairs its own source misspelling with the word, a missing-letter item offers letters that make no admitted word, and
 * a sense-relation item (synonym / antonym / word family) offers words that the same source proves unrelated to it.
 */
@Component
public final class RushQuestions {
    public record Pinned(UUID id,String sourceId,String fingerprint,String family,String prompt,String context,
                         List<Option> options,UUID answerId,String answer,String explanation,String sourceRefs) {}
    private final KingCorpus corpus;
    private record Candidate(KingCorpus.Entry entry,String difficulty) {}
    private volatile List<Candidate> catalog;
    private Map<String,Set<String>> sourceMeanings;
    private static volatile Set<String> EASY_WORDS;
    private static final Set<String> CORE_EASY_VERBS = Set.of(
        "act","add","agree","allow","answer","appear","apply","arrive","ask","attack","avoid","base",
        "be","beat","become","begin","believe","belong","break","bring","build","burn","buy","call",
        "care","carry","catch","cause","change","check","choose","clean","clear","climb","close","collect",
        "come","compare","continue","cook","copy","cost","count","cover","cross","cry","cut","dance",
        "decide","deliver","describe","destroy","die","disappear","discover","discuss","divide","do","draw","dress",
        "drink","drive","drop","eat","end","enjoy","enter","escape","explain","fall","feel","fight",
        "fill","find","finish","fit","fix","fly","follow","forget","forgive","freeze","get","give",
        "go","grow","hang","happen","hate","have","hear","help","hide","hit","hold","hope",
        "hurt","improve","include","increase","invite","join","jump","keep","kick","kill","kiss","knock",
        "know","laugh","lay","lead","learn","leave","lend","let","lie","like","listen","live",
        "look","lose","love","make","marry","match","matter","mean","measure","meet","mention","mind",
        "miss","mix","move","need","notice","obtain","occur","offer","open","order","pack","paint",
        "pass","pay","perform","pick","place","plan","play","point","prefer","prepare","press","prevent",
        "produce","protect","prove","provide","pull","push","put","rain","reach","read","receive","record",
        "refuse","remain","remember","remove","repeat","reply","report","rest","return","ride","ring","rise",
        "roll","run","save","say","see","seem","sell","send","serve","set","settle","shake",
        "share","shine","shoot","shop","shout","show","shut","sing","sink","sit","sleep","smile",
        "smoke","snow","speak","spell","spend","spill","stand","start","stay","steal","stick","stop",
        "succeed","suffer","suggest","suit","supply","support","suppose","surprise","swim","take","talk","taste",
        "teach","tear","tell","tend","test","thank","think","throw","touch","travel","treat","try",
        "turn","understand","use","visit","wait","wake","walk","want","warm","warn","wash","waste",
        "watch","wear","welcome","win","wish","wonder","work","worry","write"
    );
    public RushQuestions(KingCorpus corpus){
        this.corpus=corpus;
        if(corpus!=null&&corpus.artifactBacked()&&EASY_WORDS==null){
            try{
                var set=new HashSet<String>(CORE_EASY_VERBS);
                for(var w:corpus.vocabulary()){
                    if(w.cefr().stream().anyMatch(c->c.equals("A1")||c.equals("A2")))set.add(w.word());
                }
                EASY_WORDS=Set.copyOf(set);
            }catch(Exception ignored){}
        }
    }
    public boolean available(){return corpus.artifactBacked()&&corpus.enabled();}
    /** Typed-answer King families admitted through a provable closed choice (course version 6 adapters). */
    static final Set<String> RELATIONS=Set.of("SYNONYM","ANTONYM","WORD_FAMILY");
    static final Set<String> DERIVED=Set.of("SYNONYM","ANTONYM","WORD_FAMILY","SPELLING_CORRECTION","MISSING_LETTER");
    private volatile Map<String,List<String>> derived;
    private volatile Map<String,List<String>> alternatives;
    static final Set<String> LEXICAL=Set.of("COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION");
    private static final Set<String> STOP=Set.of("the","and","for","with","that","this","from","into","onto","upon","over","under","about","than","then","them","they",
        "their","there","what","when","which","while","who","whom","whose","been","being","have","having","something","someone","somebody","one","oneself","ones",
        "your","yours","very","more","most","some","such","also","only","other","others","used","uses","using","especially","usually","often","typically","make",
        "made","making","take","taken","taking","give","given","giving","become","becomes","person","people","thing","things","state","quality","act");
    static Set<String> content(String text){var out=new HashSet<String>();for(var w:visibleKey(text).split("[^a-z]+"))if(w.length()>=4&&!STOP.contains(w))out.add(w.length()>5?w.substring(0,5):w);return out;}
    static Set<String> tokens(String text){var out=new HashSet<String>();for(var w:visibleKey(text).split("[^a-z]+"))if(w.length()>=3&&!Set.of("the","and","one","for").contains(w))out.add(w);return out;}
    public String version(){return String.valueOf(corpus.snapshotStatus().getOrDefault("fingerprint","king-qualified-2:"+corpus.channel()));}
    static Set<String> easyWords(){
        var set=EASY_WORDS;
        return set!=null?set:CORE_EASY_VERBS;
    }
    static String classify(KingBank.Item item){
        if(item.family().equals("SPELLING_CHOICE")){
            return item.difficulty()<=2?"EASY":item.difficulty()>=4?"HARD":"MEDIUM";
        }
        if(item.family().equals("GRAMMAR_TRAP")){
            return item.difficulty()<=2?"EASY":"MEDIUM";
        }
        if(item.family().equals("PART_OF_SPEECH")){
            return item.context()!=null&&item.context().length()>100?"MEDIUM":"EASY";
        }
        if(Set.of("COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(item.family())){
            var words=item.canonical().strip().toLowerCase(Locale.ROOT).split("\\s+");
            int len=words.length;
            if(len>=4||(item.context()!=null&&item.context().length()>140)||item.difficulty()>=4)return "HARD";
            var easy=easyWords();
            if(len<=2&&Arrays.stream(words).anyMatch(easy::contains)&&(item.context()==null||item.context().length()<=85))return "EASY";
            if(item.family().equals("IDIOM_FRAGMENT")&&len<=3&&Arrays.stream(words).anyMatch(easy::contains)&&(item.context()==null||item.context().length()<=65))return "EASY";
            return "MEDIUM";
        }
        if(item.difficulty()>=4)return "HARD";
        if(item.difficulty()<=2)return "EASY";
        return "MEDIUM";
    }
    private synchronized List<Candidate> catalog(){
        if(catalog==null){
            var list=new ArrayList<Candidate>();
            var choices=derived();
            for(var e:corpus.entries("REFLEX")){
                var item=corpus.challenge(e.id());
                if(qualified(item)||choices.containsKey(e.id()))list.add(new Candidate(e,classify(item)));
            }
            catalog=List.copyOf(list);
        }
        return catalog;
    }
    public Config config(){
        if(!available())return new Config(false,Map.of(),Map.of(),"","");
        var counts=new TreeMap<String,Integer>();var topics=new TreeMap<String,List<String>>();
        for(var c:catalog())counts.merge(c.entry().family()+":"+c.difficulty(),1,Integer::sum);
        for(String d:List.of("EASY","MEDIUM","HARD")){
            var eligibleTopics=new ArrayList<String>();eligibleTopics.add("MIXED");
            for(String t:List.of("VOCABULARY","WORD_RELATIONS","SPELLING","GRAMMAR","PHRASAL_VERBS","IDIOMS_EXPRESSIONS","WORD_USE"))if(catalog().stream().filter(c->c.difficulty().equals(d)&&matchesTopic(c.entry().family(),t)).map(c->c.entry().semantic()).distinct().count()>=20)eligibleTopics.add(t);
            topics.put(d,List.copyOf(eligibleTopics));
        }
        return new Config(true,counts,topics,corpus.attribution(),version());
    }
    static String topic(String family){
        if(Set.of("SPELLING_CHOICE","SPELLING_CORRECTION","MISSING_LETTER").contains(family))return "SPELLING";
        if(RELATIONS.contains(family))return "WORD_RELATIONS";
        if(Set.of("GRAMMAR_TRAP","PART_OF_SPEECH").contains(family))return "GRAMMAR";
        if(Set.of("COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(family))return "WORD_USE";
        return "UNSUPPORTED";
    }
    static boolean matchesTopic(String family,String selected){
        return switch(selected){
            // Existing closed-choice meaning questions only. Typed-answer King records
            // have no source distractors and must not be silently converted to choices.
            case "VOCABULARY" -> Set.of("COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(family);
            case "PHRASAL_VERBS" -> family.equals("PHRASAL_VERB");
            case "IDIOMS_EXPRESSIONS" -> Set.of("IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(family);
            case "WORD_RELATIONS" -> RELATIONS.contains(family);
            default -> selected.equals("MIXED")||selected.equals(topic(family));
        };
    }
    static boolean band(int d,String difficulty){return switch(difficulty){case "EASY"->d>=1&&d<=2;case "MEDIUM"->d==3;case "HARD"->d>=4&&d<=5;default->false;};}
    /** Display equivalence is deliberately stricter than frozen King's scoring normalization. */
    static String visibleKey(String text){
        return Normalizer.normalize(Objects.toString(text,""),Normalizer.Form.NFKC)
            .replaceAll("\\p{Cf}","").replaceAll("[\\p{Z}\\s]+"," ").strip().toLowerCase(Locale.ROOT);
    }
    static boolean eligible(KingBank.Item item){
        if(item==null||topic(item.family()).equals("UNSUPPORTED")||!item.mode().equals("REFLEX")||
           item.options().size()<2||item.options().size()>4||item.prompt().isBlank()||item.prompt().length()>220||
           item.context()!=null&&item.context().length()>420)return false;
        var keys=new HashSet<String>();var scoringKeys=new HashSet<String>();int correct=0;
        for(String option:item.options()){
            if(option==null||visibleKey(option).isBlank()||option.length()>28||option.matches("(?s).*[\\p{Cc}\\p{Cf}].*")||
               !keys.add(visibleKey(option))||!scoringKeys.add(KingBank.normalize(option)))return false;
            if(KingBank.correct(item,option,null))correct++;
        }
        return correct==1&&item.options().stream().anyMatch(o->visibleKey(o).equals(visibleKey(item.canonical())))&&
            item.fingerprint()!=null&&!item.fingerprint().isBlank()&&
            (!Set.of("GRAMMAR_TRAP","PART_OF_SPEECH").contains(item.family())||item.context()!=null&&!item.context().isBlank());
    }
    boolean qualified(KingBank.Item item){
        if(!eligible(item))return false;
        var row=corpus.get(item.id());var c=row.path("content");
        if(row.path("sourceRefs").isEmpty()||!row.path("fingerprint").asText().equals(item.fingerprint()))return false;
        if(item.family().equals("SPELLING_CHOICE")){
            // A source typo which is itself an admitted word is not a defensible spelling distractor.
            if(item.options().stream().filter(o->!KingBank.correct(item,o,null)).anyMatch(o->corpus.wordEligible(visibleKey(o))))return false;
        }
        if(Set.of("PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(item.family())){
            if(item.expression()==null||!visibleKey(item.expression()).equals(visibleKey(item.canonical()))||
               item.context()==null||item.context().isBlank()||!visibleKey(item.context()).equals(visibleKey(item.meaning())))return false;
            // Typed phrase records must retain the exact definition/entry closure, not an unrelated fragment.
            if(!row.path("qualification").path("rule").asText().equals("TYPED_ENTRY_DEFINITION_CLOSED_CHOICES")||
               c.path("senseId").asText().isBlank()||row.path("qualification").path("sourceFingerprint").asText().isBlank())return false;
        }
        if(item.family().equals("COLLOCATION")){
            String prefix="Complete the documented word combination: ";
            if(!item.prompt().startsWith(prefix)||!item.prompt().endsWith("___")||
               !visibleKey(item.prompt().substring(prefix.length()).replace("___",item.canonical())).equals(visibleKey(item.expression()))||
               item.context()==null||!visibleKey(item.context()).equals(visibleKey(item.meaning()))||
               !row.path("qualification").path("rule").asText().equals("EXACT_WORDNET_LEARNER_NOUN_COMBINATION_PLUS_OANC_SPREAD_ASSOCIATION_AND_CLOSED_BLANK"))return false;
        }
        if(item.family().equals("GRAMMAR_TRAP")){
            var proof=row.path("qualification");var valid=KingCorpus.strings(proof.path("validOptions"));
            if(valid.size()!=1||!visibleKey(valid.getFirst()).equals(visibleKey(item.canonical()))||
               item.options().stream().filter(o->!KingBank.correct(item,o,null)).anyMatch(o->!KingCorpus.strings(proof.path("invalidOptions")).contains(o)))return false;
        }
        if(Set.of("COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(item.family())){
            var meanings=sourceMeanings();String meaning=visibleKey(item.meaning());
            for(String option:item.options())if(!KingBank.correct(item,option,null)){
                String expression=item.family().equals("COLLOCATION")?item.prompt().substring("Complete the documented word combination: ".length()).replace("___",option):option;
                if(meanings.getOrDefault(visibleKey(expression),Set.of()).contains(meaning))return false;
            }
        }
        if(item.family().equals("PART_OF_SPEECH")){
            int a=c.path("occurrenceStart").asInt(-1),b=c.path("occurrenceEnd").asInt(-1);
            if(a<0||b<=a||b>item.context().length()||!visibleKey(item.context().substring(a,b)).equals(visibleKey(c.path("occurrenceText").asText()))||
               !row.path("qualification").path("rule").asText().equals("UNIQUE_OCCURRENCE_POS_WITH_SINGLE_LEXICAL_WORD_CLASS"))return false;
        }
        return true;
    }
    private synchronized Map<String,Set<String>> sourceMeanings(){
        if(sourceMeanings==null){var map=new HashMap<String,Set<String>>();
            for(var e:corpus.entries("REFLEX"))if(Set.of("COLLOCATION","PHRASAL_VERB","IDIOM_FRAGMENT","FIXED_EXPRESSION").contains(e.family())){
                var i=corpus.challenge(e.id());if(i.expression()!=null&&!visibleKey(i.meaning()).isBlank())map.computeIfAbsent(visibleKey(i.expression()),k->new HashSet<>()).add(visibleKey(i.meaning()));
            }sourceMeanings=map;
        }return sourceMeanings;
    }
    /** True when the item is offered by Rush: a qualified closed-choice item, or a typed item with a provable closed choice. */
    public boolean admitted(KingBank.Item item){return item!=null&&(qualified(item)||derived().containsKey(item.id()));}
    /**
     * Run variety for lexical families: the King source pairs nearly every idiom, phrasal verb, fixed expression and
     * collocation with the same three filler choices ("black gold", "break wind", "fly the flag" …), so a learner could
     * learn the fillers instead of the English. Alternatives are other qualified expressions of the same family and
     * part of speech, held to the source's own rule (their source meanings never include this meaning) and stricter
     * guards: no shared content word between the meanings, no shared word between the expressions, and — for
     * collocations — no documented combination with the prompt word.
     */
    public List<String> alternativeChoices(String id){return alternatives().getOrDefault(id,List.of());}
    private synchronized Map<String,List<String>> alternatives(){
        if(alternatives!=null)return alternatives;
        var out=new HashMap<String,List<String>>();
        if(corpus==null||!corpus.artifactBacked()){alternatives=out;return out;}
        record Expr(String id,String family,String pos,String expression,String meaning,String semantic) {}
        var pool=new HashMap<String,List<Expr>>();var meanings=sourceMeanings();
        for(var e:corpus.entries("REFLEX")){
            // Collocations keep their source choices: a one-word alternative can form a plausible combination.
            if(!LEXICAL.contains(e.family())||e.family().equals("COLLOCATION"))continue;var item=corpus.challenge(e.id());if(!qualified(item))continue;
            var row=corpus.get(e.id());String pos=row.path("qualification").path("typeEvidence").path("pos").asText("");
            String expression=item.family().equals("COLLOCATION")?item.canonical():item.expression();
            if(expression==null||expression.length()>28)continue;
            pool.computeIfAbsent(item.family()+"|"+(item.family().equals("COLLOCATION")?"":pos),k->new ArrayList<>()).add(new Expr(e.id(),item.family(),pos,expression.strip(),item.meaning(),e.semantic()));
        }
        for(var list:pool.values()){
            for(var x:list){
                var item=corpus.challenge(x.id());var own=content(x.meaning());var words=tokens(x.expression());var good=new ArrayList<String>();
                String prefix=x.family().equals("COLLOCATION")?item.prompt().substring("Complete the documented word combination: ".length()).replace("___","").strip():"";
                if(x.family().equals("COLLOCATION"))words.addAll(tokens(prefix));
                var rng=new Random(item.fingerprint().hashCode()^0x51ED27);var order=new ArrayList<>(list);Collections.shuffle(order,rng);
                for(var y:order){
                    if(good.size()>=8)break;
                    if(y.id().equals(x.id())||y.semantic().equals(x.semantic())||visibleKey(y.expression()).equals(visibleKey(x.expression())))continue;
                    String candidate=y.expression();if(KingBank.correct(item,candidate,null))continue;
                    if(x.family().equals("COLLOCATION")){
                        String combo=prefix+" "+candidate;
                        if(meanings.containsKey(visibleKey(combo))||candidate.contains(" "))continue;
                    }else if(meanings.getOrDefault(visibleKey(candidate),Set.of()).contains(visibleKey(x.meaning())))continue;
                    boolean clash=false;for(var t:tokens(candidate))if(words.contains(t)){clash=true;break;}if(clash)continue;
                    var theirs=content(y.meaning());for(var m:meanings.getOrDefault(visibleKey(candidate),Set.of()))theirs.addAll(content(m));
                    for(var t:theirs)if(own.contains(t)){clash=true;break;}if(clash)continue;
                    if(visibleKey(candidate).isBlank()||candidate.length()>28||candidate.matches("(?s).*[\\p{Cc}\\p{Cf}].*"))continue;
                    good.add(candidate);
                }
                if(good.size()>=3)out.put(x.id(),List.copyOf(good));
            }
        }
        alternatives=Map.copyOf(out);return alternatives;
    }
    /** The adapter-built wrong choices of a typed-answer item (empty for closed-choice items). */
    public List<String> derivedChoices(String id){return derived().getOrDefault(id,List.of());}
    private static boolean word(String w){return w!=null&&w.matches("[a-z]{3,14}");}
    /** OEWN sense id → [part of speech digit, lexicographer file] ("oewn-grim__5.00.00…" → ["5","00"]). */
    static String[] sense(String id){
        if(id==null)return null;int at=id.indexOf("__");if(at<0||id.length()<at+6)return null;
        String rest=id.substring(at+2);return rest.length()>=4&&Character.isDigit(rest.charAt(0))&&rest.charAt(1)=='.'?new String[]{rest.substring(0,1),rest.substring(2,4)}:null;
    }
    private static boolean sharesStem(String a,String b){if(a==null||b==null)return false;int n=Math.min(4,Math.min(a.length(),b.length()));return a.regionMatches(true,0,b,0,n)||a.contains(b)||b.contains(a);}
    /**
     * Wrong choices for typed-answer items, built only where the source itself proves them wrong:
     * SPELLING_CORRECTION — the item's own source misspelling, which must not be an admitted word;
     * MISSING_LETTER — letters of the same kind (vowel / consonant) whose word is not admitted (the meaning is shown);
     * SYNONYM / ANTONYM / WORD_FAMILY (nouns and verbs) — answers of other relation items of the same part of speech
     * from a different lexicographer file, never related to the prompt word or the answer by any source relation, never
     * sharing a stem with them, never one of the item's own accepted words. Items without enough proof are not offered.
     */
    private synchronized Map<String,List<String>> derived(){
        if(derived!=null)return derived;
        var out=new HashMap<String,List<String>>();
        if(corpus==null||!corpus.artifactBacked()){derived=out;return out;}
        var related=new HashMap<String,Set<String>>();var lexfiles=new HashMap<String,Set<String>>();var pool=new TreeMap<String,TreeSet<String>>();
        var relationItems=new ArrayList<KingBank.Item>();
        for(var e:corpus.entries("REFLEX")){
            if(!DERIVED.contains(e.family()))continue;var item=corpus.challenge(e.id());
            if(RELATIONS.contains(e.family())){
                var c=corpus.get(e.id()).path("content");String lemma=c.path("lemma").asText("").toLowerCase(Locale.ROOT),answer=visibleKey(item.canonical());
                var all=new HashSet<String>();all.add(answer);for(var w:item.relationSet())all.add(visibleKey(w));for(var w:item.accepted())all.add(visibleKey(w));
                related.computeIfAbsent(lemma,k->new HashSet<>()).addAll(all);for(var w:all)related.computeIfAbsent(w,k->new HashSet<>()).add(lemma);
                String[] target=sense(c.path("targetSenseId").asText(null)),source=sense(c.path("senseId").asText(null));
                if(target!=null)lexfiles.computeIfAbsent(answer,k->new HashSet<>()).add(target[0]+"."+target[1]);
                if(source!=null)lexfiles.computeIfAbsent(lemma,k->new HashSet<>()).add(source[0]+"."+source[1]);
                if(target!=null&&(target[0].equals("1")||target[0].equals("2"))&&word(answer))pool.computeIfAbsent(target[0],k->new TreeSet<>()).add(answer);
                relationItems.add(item);
            }else if(e.family().equals("SPELLING_CORRECTION")){
                String typo=visibleKey(item.prompt()),answer=visibleKey(item.canonical());
                if(item.fingerprint()!=null&&!item.fingerprint().isBlank()&&word(answer)&&typo.matches("[a-z]{3,28}")&&!typo.equals(answer)&&!corpus.wordEligible(typo)&&item.options().isEmpty())out.put(e.id(),List.of(item.prompt().strip()));
            }else if(e.family().equals("MISSING_LETTER")){
                var c=corpus.get(e.id()).path("content");String lemma=c.path("lemma").asText("").toLowerCase(Locale.ROOT),pattern=item.prompt().strip().toLowerCase(Locale.ROOT),answer=visibleKey(item.canonical());
                Integer at=item.missingIndex();
                if(item.fingerprint()==null||at==null||lemma.length()<5||!lemma.matches("[a-z]+")||answer.length()!=1||at<0||at>=lemma.length()||pattern.length()!=lemma.length()||pattern.charAt(at)!='_'||
                   !(pattern.substring(0,at)+answer+pattern.substring(at+1)).equals(lemma)||item.meaning()==null||item.meaning().isBlank())continue;
                boolean vowel="aeiou".indexOf(answer.charAt(0))>=0;String letters=vowel?"aeiouy":"bcdfghjklmnprstvwz";var wrong=new ArrayList<String>();
                for(char ch:letters.toCharArray()){String l=String.valueOf(ch);if(l.equals(answer))continue;String made=pattern.substring(0,at)+l+pattern.substring(at+1);if(!corpus.wordEligible(made))wrong.add(l);}
                if(wrong.size()>=3)out.put(e.id(),List.copyOf(wrong));
            }
        }
        for(var item:relationItems){
            var c=corpus.get(item.id()).path("content");String lemma=c.path("lemma").asText("").toLowerCase(Locale.ROOT),answer=visibleKey(item.canonical());
            String[] target=sense(c.path("targetSenseId").asText(null)),source=sense(c.path("senseId").asText(null));
            if(item.fingerprint()==null||item.fingerprint().isBlank()||!word(answer)||!word(lemma)||target==null||source==null||!(target[0].equals("1")||target[0].equals("2"))||
               item.context()==null||item.context().isBlank()||item.context().length()>300)continue;
            var own=new HashSet<String>();own.add(answer);own.add(lemma);for(var w:item.relationSet())own.add(visibleKey(w));for(var w:item.accepted())own.add(visibleKey(w));
            var blockedLex=new HashSet<String>(List.of(target[0]+"."+target[1],source[0]+"."+source[1]));
            var wrong=new ArrayList<String>();
            for(String w:pool.getOrDefault(target[0],new TreeSet<>())){
                if(own.contains(w)||related.getOrDefault(w,Set.of()).contains(lemma)||related.getOrDefault(w,Set.of()).contains(answer)||related.getOrDefault(lemma,Set.of()).contains(w)||related.getOrDefault(answer,Set.of()).contains(w))continue;
                if(lexfiles.getOrDefault(w,Set.of()).stream().anyMatch(blockedLex::contains)||lexfiles.getOrDefault(w,Set.of()).isEmpty())continue;
                boolean stem=false;for(var o:own)if(sharesStem(w,o)){stem=true;break;}if(stem)continue;
                wrong.add(w);
            }
            if(wrong.size()<3)continue;
            // A stable, item-specific spread over the eligible words (not alphabetical neighbours).
            var rng=new Random(item.fingerprint().hashCode());Collections.shuffle(wrong,rng);
            out.put(item.id(),List.copyOf(wrong.subList(0,Math.min(12,wrong.size()))));
        }
        derived=Map.copyOf(out);return derived;
    }
    /** A typed-answer item as a pinned gate question (adapter rule above). */
    private Pinned pinDerived(KingCorpus.Entry e,String family,Random random){
        var item=corpus.challenge(e.id());var wrongAll=derivedChoices(e.id());if(wrongAll.isEmpty())return null;
        var wrong=new ArrayList<>(wrongAll);Collections.shuffle(wrong,random);
        int target=family.equals("SPELLING_CORRECTION")?2:random.nextInt(100)<35?3:4;
        var labels=new ArrayList<String>();String answer=family.equals("MISSING_LETTER")?visibleKey(item.canonical()):item.canonical().strip();labels.add(answer);
        labels.addAll(wrong.subList(0,Math.min(target-1,wrong.size())));Collections.shuffle(labels,random);
        var options=new ArrayList<Option>();UUID answerId=null;
        for(String label:labels){var id=new UUID(random.nextLong(),random.nextLong());options.add(new Option(id,label));if(label.equals(answer))answerId=id;}
        String prompt,context,explanation;
        switch(family){
            case "SPELLING_CORRECTION"->{prompt="Choose the correctly spelled word.";context="";explanation=item.meaning();}
            case "MISSING_LETTER"->{prompt="Choose the missing letter: "+item.prompt().strip();context=item.meaning();var c=corpus.get(e.id()).path("content");explanation=c.path("lemma").asText("")+" — "+item.meaning();}
            default->{prompt=item.prompt().strip().replaceFirst("^Find ","Choose ");context=item.context();
                var all=new ArrayList<String>();all.add(item.canonical());for(var w:item.relationSet())if(!all.contains(w))all.add(w);
                explanation=String.join(", ",all)+" — "+item.meaning();}
        }
        return new Pinned(new UUID(random.nextLong(),random.nextLong()),item.id(),item.fingerprint(),family,prompt,context,List.copyOf(options),answerId,answer,explanation,item.sourceRef());
    }
    /**
     * Skybound pacing: the same selected questions, ordered so the number of doors never decreases along the course
     * (two-door warm-ups first, the widest choices at the final Grand Gate). Stable, so seeded family variety remains.
     */
    public static List<Pinned> escalate(List<Pinned> selected){
        var ordered=new ArrayList<>(selected);ordered.sort(Comparator.comparingInt(q->q.options().size()));return List.copyOf(ordered);
    }
    static final int STRONG_RECENT=240;
    /** One qualified source item as a pinned gate question (2–4 doors from its own source choices), or null. */
    private Pinned pin(KingCorpus.Entry e,String family,Random random){
        if(DERIVED.contains(family))return pinDerived(e,family,random);
        var item=corpus.challenge(e.id());if(!qualified(item))return null;
        int draw=random.nextInt(100),target=draw<15?2:draw<60?3:4;
        var wrong=item.options().stream().filter(o->!KingBank.correct(item,o,null)).collect(java.util.stream.Collectors.toCollection(ArrayList::new));
        var alternative=alternativeChoices(e.id());
        if(!alternative.isEmpty()){wrong=new ArrayList<>(alternative);}
        Collections.shuffle(wrong,random);var labels=new ArrayList<String>();labels.add(item.options().stream().filter(o->KingBank.correct(item,o,null)).findFirst().orElseThrow());
        labels.addAll(wrong.subList(0,Math.min(target-1,wrong.size())));Collections.shuffle(labels,random);
        var options=new ArrayList<Option>();UUID answerId=null;
        for(String label:labels){var id=new UUID(random.nextLong(),random.nextLong());options.add(new Option(id,label));if(KingBank.correct(item,label,null))answerId=id;}
        String prompt=item.prompt(),context=item.context()==null?"":item.context();
        if(family.equals("PART_OF_SPEECH")){
            var c=corpus.get(e.id()).path("content");int start=c.path("occurrenceStart").asInt(-1),end=c.path("occurrenceEnd").asInt(-1);
            if(start<0||end<=start||end>context.length())return null;
            context=context.substring(0,start)+"["+context.substring(start,end)+"]"+context.substring(end);
        }
        return new Pinned(new UUID(random.nextLong(),random.nextLong()),item.id(),item.fingerprint(),family,prompt,context,List.copyOf(options),answerId,item.canonical(),item.meaning(),item.sourceRef());
    }
    /**
     * Variety-first selection. `recent` is the account's exposure, newest first: the newest {@value #STRONG_RECENT}
     * sources are avoided until the pool is exhausted, older ones only on the first pass. Each gate draws its family
     * with weight √(unused candidates) — large families supply more gates, small ones still appear but no longer
     * repeat their few items run after run — never the same family twice in a row when another is left, and at most
     * 40 % of a course from one family. Within a family the order is a fresh seeded shuffle.
     */
    public List<Pinned> select(Start request,Set<String> recent,long seed){
        if(!available())throw new RushException(503,"CONTENT_UNAVAILABLE");
        var random=new Random(seed);var buckets=new TreeMap<String,List<KingCorpus.Entry>>();
        for(var candidate:catalog()){var e=candidate.entry();if(candidate.difficulty().equals(request.difficulty())&&
            matchesTopic(e.family(),request.topic()))buckets.computeIfAbsent(e.family(),k->new ArrayList<>()).add(e);}
        buckets.values().forEach(b->Collections.shuffle(b,random));var result=new ArrayList<Pinned>();var semantics=new HashSet<String>();
        var strong=new HashSet<String>();var all=new HashSet<String>();int index=0;
        for(String id:recent==null?Set.<String>of():recent){all.add(id);if(index++<STRONG_RECENT)strong.add(id);}
        int cap=buckets.size()>=3?Math.max(2,(int)Math.ceil(request.checkpoints()*.4)):request.checkpoints();
        var used=new HashSet<String>();
        // Run variety: no two gates share two wrong choices (source filler choices repeat across items), and one
        // grammar rule appears at most twice per run.
        var wrongLabels=new ArrayList<Set<String>>();var rules=new HashMap<String,Integer>();
        // Pass 0 avoids every recent source, pass 1 only the newest, pass 2 accepts any source (tiny pools).
        for(int pass=0;pass<3&&result.size()<request.checkpoints();pass++){
            var cursors=new HashMap<String,Integer>();var picks=new HashMap<String,Integer>();String last="";int tried=0;
            for(var q:result)picks.merge(q.family(),1,Integer::sum);
            var open=new ArrayList<>(buckets.keySet());
            while(result.size()<request.checkpoints()&&!open.isEmpty()&&tried<6000){
                var choices=open.stream().filter(f->picks.getOrDefault(f,0)<cap).toList();if(choices.isEmpty())choices=open;
                String l=last;var fresh=choices.stream().filter(f->!f.equals(l)).toList();if(!fresh.isEmpty())choices=fresh;
                double total=0;var weights=new double[choices.size()];
                for(int i=0;i<choices.size();i++){var f=choices.get(i);weights[i]=Math.sqrt(Math.max(1,buckets.get(f).size()-cursors.getOrDefault(f,0)));total+=weights[i];}
                double draw=random.nextDouble()*total;int pick=0;while(pick<weights.length-1&&(draw-=weights[pick])>0)pick++;
                String family=choices.get(pick);var list=buckets.get(family);Pinned found=null;
                while(found==null&&cursors.getOrDefault(family,0)<list.size()&&tried<6000){
                    int cursor=cursors.getOrDefault(family,0);cursors.put(family,cursor+1);tried++;
                    var e=list.get(cursor);if(used.contains(e.id())||semantics.contains(e.semantic())||pass==0&&all.contains(e.id())||pass==1&&strong.contains(e.id()))continue;
                    found=pin(e,family,random);
                    if(found!=null&&pass<2){
                        var mine=new HashSet<String>();for(var o:found.options())if(!o.id().equals(found.answerId()))mine.add(visibleKey(o.label()));
                        boolean overlap=false;for(var other:wrongLabels){int same=0;for(var w:mine)if(other.contains(w))same++;if(same>=2){overlap=true;break;}}
                        String rule=found.family().equals("GRAMMAR_TRAP")?found.explanation():null;
                        if(overlap||rule!=null&&rules.getOrDefault(rule,0)>=2)found=null;
                    }
                }
                if(found==null){open.remove(family);continue;}
                var mineWrong=new HashSet<String>();for(var o:found.options())if(!o.id().equals(found.answerId()))mineWrong.add(visibleKey(o.label()));wrongLabels.add(mineWrong);
                if(found.family().equals("GRAMMAR_TRAP"))rules.merge(found.explanation(),1,Integer::sum);
                result.add(found);used.add(found.sourceId());semantics.add(buckets.get(family).get(cursors.get(family)-1).semantic());picks.merge(family,1,Integer::sum);last=family;
            }
        }
        if(result.size()!=request.checkpoints())throw new RushException(409,"INSUFFICIENT_QUESTIONS");
        return List.copyOf(result);
    }
}
