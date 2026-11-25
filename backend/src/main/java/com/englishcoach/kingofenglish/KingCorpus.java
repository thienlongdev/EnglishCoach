package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.zip.GZIPInputStream;

/** Immutable local corpus indexes and one bounded shared decoded-content cache.
 * Neither the canonical working DB nor any internet source is reachable here.
 */
@Component
public final class KingCorpus implements AutoCloseable {
    public record Entry(String id,String mode,String family,int difficulty,String semantic,
                        List<String> phrases,List<String> concepts,List<String> lexemes,int shard) {}
    public static final int CACHE_CAP=128;
    public static final long CACHE_TTL=180_000;
    private static final ObjectMapper JSON=new ObjectMapper();
    private record Cached(JsonNode value,long at) {}
    private final String channel;
    private final Map<String,Entry> index=new LinkedHashMap<>();
    private final Map<String,List<Entry>> modes=new HashMap<>();
    private final List<Connection> shards=new ArrayList<>();
    private final List<Path> temporary=new ArrayList<>();
    private final Set<String> lexicon=new HashSet<>();
    private final LinkedHashMap<String,Cached> cache=new LinkedHashMap<>(32,.75f,true);
    private volatile long nextCacheExpiryAt=Long.MAX_VALUE;
    private int cachePeak;
    private String sourceLockSha256;
    private final java.time.Clock clock;
    private final boolean measureHeap;
    private final java.util.function.Function<String,InputStream> resourceOverride;
    private long artifactHeap,indexHeap;
    private KingSnapshot snapshot;
    private final Map<String,List<List<Entry>>> selectionBuckets=new HashMap<>();
    private final Map<String,String> answerKeys=new HashMap<>();
    /** Read-only lexical projection of the same approved package, without copying a corpus. */
    public record VocabularyWord(String word,Set<String> cefr,Set<String> partsOfSpeech) {}
    private List<VocabularyWord> vocabulary=List.of();

    @org.springframework.beans.factory.annotation.Autowired
    public KingCorpus(Environment environment,@Value("${king.content-channel:}") String requested,
                      @Value("${king.engineering:false}") boolean engineering,
                      @Value("${king.snapshot-store:}") String store) {
        this(resolve(requested,engineering,Arrays.stream(environment.getActiveProfiles()).anyMatch(p->Set.of("prod","production").contains(p))),
             KingSnapshot.read(store,Arrays.stream(environment.getActiveProfiles()).anyMatch(p->Set.of("prod","production").contains(p)),
                 Arrays.asList(environment.getActiveProfiles()).contains("king-local-test")));
    }
    KingCorpus(String channel,KingSnapshot snapshot) {
        this.resourceOverride=snapshot==null?null:snapshot::resource;this.measureHeap=false;this.clock=java.time.Clock.systemUTC();
        this.channel=resolve(channel,false,false);this.snapshot=this.channel.equals("PRODUCTION")?snapshot:null;
        if(preview()||this.snapshot!=null)try{load();if(this.snapshot!=null)applySnapshot();buildSelectionIndexes();}catch(Exception e){close();throw new IllegalStateException("King corpus failed closed",e);}
    }
    private void applySnapshot(){
        index.entrySet().removeIf(e->!snapshot.includes(e.getKey()));
        modes.replaceAll((mode,entries)->entries.stream().filter(e->snapshot.includes(e.id())).toList());
        lexicon.removeIf(word->!snapshot.includesWord(word));snapshot.verifyLoaded(this);
    }
    static String resolve(String requested,boolean engineering,boolean productionProfile) {
        String c=requested==null||requested.isBlank()?(engineering&&!productionProfile?"ENGINEERING":"PRODUCTION"):requested.strip();
        if(!Set.of("PRODUCTION","REVIEW_PREVIEW","ENGINEERING").contains(c))throw new IllegalArgumentException("Invalid King content channel");
        if(c.equals("ENGINEERING")&&productionProfile)throw new IllegalArgumentException("Engineering King content prohibited in production profile");
        return c;
    }
    public KingCorpus(String channel) {
        this(channel,java.time.Clock.systemUTC());
    }
    KingCorpus(String channel,java.time.Clock clock) {
        this(channel,clock,false);
    }
    KingCorpus(String channel,java.time.Clock clock,boolean measureHeap) {
        this(channel,clock,measureHeap,null);
    }
    KingCorpus(String channel,java.time.Clock clock,boolean measureHeap,java.util.function.Function<String,InputStream> resourceOverride) {
        this.resourceOverride=resourceOverride;
        this.measureHeap=measureHeap;this.clock=clock;
        this.channel=resolve(channel,false,false);
        if(preview())try{load();buildSelectionIndexes();}catch(Exception e){close();throw new IllegalStateException("King corpus failed closed",e);}
    }
    public String channel(){return channel;}
    public boolean preview(){return channel.equals("REVIEW_PREVIEW");}
    public boolean artifactBacked(){return preview()||snapshot!=null;}
    public boolean enabled(){return channel.equals("ENGINEERING")||preview()||snapshot!=null&&snapshot.current();}
    public Map<String,Object> snapshotStatus(){return snapshot==null?Map.of("activationStatus","NO_ACTIVE_SNAPSHOT"):snapshot.current()?snapshot.status():Map.of("activationStatus","RELOAD_REQUIRED");}
    private InputStream resource(String name) {
        var in=resourceOverride==null?KingCorpus.class.getResourceAsStream("/data/king/corpus/"+name):resourceOverride.apply(name);
        if(in==null)throw new IllegalStateException("Missing King corpus artifact: "+name);return in;
    }
    private void load() throws Exception {
        var rawCounts=new HashMap<String,Integer>();
        JsonNode manifest;
        try(var in=resource("manifest.json")){manifest=JSON.readTree(in);}
        String expectedSourceLock=manifest.path("sourceLockSha256").asText();
        var sourceDigest=MessageDigest.getInstance("SHA-256");
        try(var in=resource("sources.lock.json")){in.transferTo(new java.security.DigestOutputStream(OutputStream.nullOutputStream(),sourceDigest));}
        if(!HexFormat.of().formatHex(sourceDigest.digest()).equals(expectedSourceLock))throw new IllegalStateException("King source-lock mismatch");
        if(manifest.path("schemaVersion").asInt()!=1||!manifest.path("buildVersion").asText().equals("king-qualified-2")||
           !expectedSourceLock.matches("[a-f0-9]{64}")||manifest.path("humanApproved").asInt(-1)!=0||manifest.path("productionActive").asInt(-1)!=0)
            throw new IllegalStateException("Incompatible King corpus manifest");
        this.sourceLockSha256=expectedSourceLock;
        var buildDigest=MessageDigest.getInstance("SHA-256");
        for(var spec:manifest.path("shards")){
            String name=spec.path("name").asText();
            if(!Set.of("king-core.sqlite.gz","king-phrases-cc-by-sa.sqlite.gz").contains(name))throw new IllegalStateException("Invalid King shard name");
            var md=MessageDigest.getInstance("SHA-256");
            Path path=Files.createTempFile("king-corpus-",".sqlite");temporary.add(path);
            try(var raw=resource(name);var checked=new java.security.DigestInputStream(raw,md);var gzip=new GZIPInputStream(checked);var out=Files.newOutputStream(path)){
                gzip.transferTo(out);
                checked.transferTo(OutputStream.nullOutputStream());
            }
            if(!HexFormat.of().formatHex(md.digest()).equals(spec.path("sha256").asText()))throw new IllegalStateException("King shard checksum mismatch");
            Connection db=DriverManager.getConnection("jdbc:sqlite:file:"+path.toAbsolutePath().toString().replace('\\','/')+"?mode=ro&immutable=1");shards.add(db);
            try(var statement=db.createStatement()){
                var contentDigest=MessageDigest.getInstance("SHA-256");
                statement.execute("PRAGMA query_only=ON");statement.execute("PRAGMA cache_size=-2048");
                var meta=new HashMap<String,String>();
                try(var rs=statement.executeQuery("SELECT key,value FROM manifest")){while(rs.next())meta.put(rs.getString(1),rs.getString(2));}
                if(!"1".equals(meta.get("schemaVersion"))||!"king-qualified-2".equals(meta.get("buildVersion"))||
                   !manifest.path("sourceLockSha256").asText().equals(meta.get("sourceLockSha256"))||
                   !spec.path("contentSha256").asText().equals(meta.get("contentSha256")))throw new IllegalStateException("Incompatible King shard");
                boolean share=spec.path("shareAlike").asBoolean();
                if(share!=name.equals("king-phrases-cc-by-sa.sqlite.gz")||!meta.get("licenseClass").equals(share?"CC-BY-SA-4.0":"ATTRIBUTED_CORE"))throw new IllegalStateException("King shard license mismatch");
                try(var rs=statement.executeQuery("SELECT body FROM content ORDER BY id")){while(rs.next()){
                    byte[] bytes=(rs.getString(1)+"\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);contentDigest.update(bytes);buildDigest.update(bytes);
                }}
                try(var rs=statement.executeQuery("SELECT word FROM lexicon ORDER BY word")){while(rs.next()){
                    String word=rs.getString(1);lexicon.add(word);byte[] bytes=(word+"\n").getBytes(java.nio.charset.StandardCharsets.UTF_8);contentDigest.update(bytes);buildDigest.update(bytes);
                }}
                if(!HexFormat.of().formatHex(contentDigest.digest()).equals(spec.path("contentSha256").asText()))throw new IllegalStateException("King logical content mismatch");
            }
        }
        if(measureHeap)artifactHeap=measuredHeap();
        for(int shardIndex=0;shardIndex<shards.size();shardIndex++){
            final int shard=shardIndex;
            try(var statement=shards.get(shard).createStatement()){
                try(var rs=statement.executeQuery("SELECT id,mode,family,difficulty,semantic_hash,links FROM content ORDER BY id")){
                    while(rs.next()){
                        rawCounts.merge(rs.getString(2),1,Integer::sum);
                        if(snapshot!=null&&!snapshot.includes(rs.getString(1)))continue;
                        var phrases=new ArrayList<String>();var concepts=new ArrayList<String>();var lexemes=new ArrayList<String>();
                        for(var link:JSON.readTree(rs.getString(6)))switch(link.path("confidence").asText()){
                            case "PHRASE_EXACT" -> phrases.add(link.path("phraseId").asText());
                            case "EXACT_SENSE" -> concepts.add(link.path("conceptId").asText(link.path("senseId").asText()));
                            case "LEXEME_ONLY" -> lexemes.add(link.path("lexemeId").asText());
                            case "UNKNOWN" -> { }
                            default -> throw new IllegalStateException("Invalid King semantic confidence");
                        }
                        var e=new Entry(rs.getString(1),rs.getString(2),rs.getString(3),rs.getInt(4),rs.getString(5),List.copyOf(phrases),List.copyOf(concepts),List.copyOf(lexemes),shard);
                        if(index.put(e.id(),e)!=null)throw new IllegalStateException("Duplicate King corpus ID");
                        modes.computeIfAbsent(e.mode(),k->new ArrayList<>()).add(e);
                    }
                }
            }
        }
        if(measureHeap)indexHeap=measuredHeap();
        if(shards.size()!=2||snapshot==null&&(count("REORDER")<2000||count("REFLEX")<3000||count("EXPLAIN")<800||count("CONQUEST")<150||lexicon.size()<10000))
            throw new IllegalStateException("King corpus provider floors failed");
        if(snapshot==null)for(String family:KingBank.REFLEX_TYPES)if(entries("REFLEX").stream().filter(e->e.family().equals(family)).count()<100)throw new IllegalStateException("King Reflex family floor failed: "+family);
        modes.replaceAll((k,v)->List.copyOf(v));
        for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST"))if(rawCounts.getOrDefault(mode,0)!=manifest.path("counts").path(mode).asInt(-1))throw new IllegalStateException("King manifest provider count mismatch");
        if(!HexFormat.of().formatHex(buildDigest.digest()).equals(manifest.path("contentBuildSha256").asText()))throw new IllegalStateException("King build hash mismatch");
    }
    private static long measuredHeap(){System.gc();return Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory();}
    public Map<String,Long> initializationMemory(){return Map.of("afterArtifactsBytes",artifactHeap,"afterIndexesBytes",indexHeap);}
    public int count(String mode){return entries(mode).size();}
    public List<Entry> entries(String mode){return modes.getOrDefault(mode,List.of());}
    public Entry entry(String id){return index.get(id);}
    public boolean wordEligible(String word){return lexicon.contains(word);}
    /** Read-only view of the approved lexicon keys (Soán ngôi: Echo's preferred words on generated boards). */
    public Set<String> lexiconWords(){return Collections.unmodifiableSet(lexicon);}
    public List<VocabularyWord> vocabulary(){
        if(!artifactBacked()||!enabled())throw new IllegalStateException("Approved vocabulary unavailable");
        return vocabulary;
    }
    private JsonNode parseAndVerifyRow(Entry e,String body) throws Exception {
        var row=JSON.readTree(body);
        if(!row.path("id").asText().equals(e.id())||!row.path("mode").asText().equals(e.mode())||!row.path("semanticHash").asText().equals(e.semantic())||
           !row.path("confidence").asText().equals("HIGH_CONFIDENCE_SOURCE_BACKED")||!row.path("humanReview").isNull()||
           !row.path("reviewStatus").asText().equals("HUMAN_REVIEW_PENDING")||row.path("flags").size()!=0||
           !row.path("sourceLockSha256").asText().equals(sourceLockSha256))throw new IllegalStateException("Ineligible runtime King record");
        return row;
    }
    private void expireCacheLocked(long now){
        long earliest=Long.MAX_VALUE;
        for(var it=cache.values().iterator();it.hasNext();){
            Cached c=it.next();
            if(now-c.at()>=CACHE_TTL){
                it.remove();
            }else{
                long exp=c.at()+CACHE_TTL;
                if(exp<earliest)earliest=exp;
            }
        }
        nextCacheExpiryAt=earliest;
    }
    /** Lock-free fast-path idle eviction so decoded JsonNode trees are released from Tenured heap after gameplay stops. */
    public void expireCache(){
        long now=clock.millis();
        if(now<nextCacheExpiryAt)return;
        synchronized(this){
            if(now>=nextCacheExpiryAt)expireCacheLocked(now);
        }
    }
    /** Clears any decoded JsonNode entries warmed by startup indexers (e.g., Quiz Rush / Spelling) once boot completes. */
    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public synchronized void clearCache(){
        cache.clear();
        nextCacheExpiryAt=Long.MAX_VALUE;
    }
    public synchronized JsonNode get(String id){
        Entry e=index.get(id);if(e==null)throw new IllegalArgumentException("Unknown King corpus ID");
        long now=clock.millis();
        if(now>=nextCacheExpiryAt)expireCacheLocked(now);
        var hit=cache.get(id);
        if(hit!=null&&now-hit.at()<CACHE_TTL)return hit.value();cache.remove(id);
        try(var query=shards.get(e.shard()).prepareStatement("SELECT body FROM content WHERE id=?")){
            query.setString(1,id);
            try(var rs=query.executeQuery()){
                if(!rs.next())throw new IllegalStateException("Missing indexed King record");
                var row=parseAndVerifyRow(e,rs.getString(1));
                cache.put(id,new Cached(row,now));
                long exp=now+CACHE_TTL;
                if(exp<nextCacheExpiryAt)nextCacheExpiryAt=exp;
                while(cache.size()>CACHE_CAP)cache.remove(cache.keySet().iterator().next());
                cachePeak=Math.max(cachePeak,cache.size());return row;
            }
        }catch(Exception ex){throw new IllegalStateException("King content lookup failed closed",ex);}
    }
    public synchronized Map<String,Integer> cacheState(){expireCacheLocked(clock.millis());return Map.of("entries",cache.size(),"peak",cachePeak,"cap",CACHE_CAP);}
    public String attribution(){try(var in=resource("ATTRIBUTION.md")){return new String(in.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);}catch(IOException e){throw new IllegalStateException("King attribution unavailable",e);}}
    public Map<String,Object> counts(){
        var families=new TreeMap<String,Long>();for(var e:entries("REFLEX"))families.merge(e.family(),1L,Long::sum);
        return Map.of("channel",channel,"reorder",count("REORDER"),"reflex",count("REFLEX"),"explain",count("EXPLAIN"),"conquest",count("CONQUEST"),"lexicon",lexicon.size(),"families",families,
            "productionActive",snapshot!=null&&snapshot.status().get("activationStatus").equals("PRODUCTION_ACTIVE")?1:0,"humanApproved",snapshot!=null?1:0);
    }
    public static List<String> strings(JsonNode node){var out=new ArrayList<String>();if(node.isArray())node.forEach(x->out.add(x.asText()));return List.copyOf(out);}
    public KingBank.Item challenge(String id){
        var r=get(id);var c=r.path("content");String family=r.path("family").asText();
        return new KingBank.Item(id,r.path("mode").asText(),family,c.path("prompt").asText("Arrange the chunks."),strings(c.path("tokens")),strings(c.path("options")),
            c.path("canonical").asText(),strings(c.path("accepted")),c.path("meaning").asText(),c.path("difficulty").asInt(3),c.path("cefr").asText("UNKNOWN"),c.path("difficultySource").asText("UNKNOWN"),
            "SOURCE_BACKED_HIGH_CONFIDENCE",r.path("sourceRefs").toString(),"king-qualified-2","HIGH_CONFIDENCE",null,r.path("fingerprint").asText(),
            c.path("expression").isTextual()?c.path("expression").asText():null,c.path("context").isTextual()?c.path("context").asText():null,
            strings(c.path("relationSet")),c.path("missingIndex").isInt()?c.path("missingIndex").asInt():null);
    }
    public KingExplainBank.Item explain(String id){
        var r=get(id);var c=r.path("content");return new KingExplainBank.Item(id,c.path("target").asText(),strings(c.path("acceptedAliases")),strings(c.path("progressiveClues")),strings(c.path("forbiddenForms")),
            c.path("meaning").asText(),c.path("pos").asText(),c.path("difficulty").asInt(3),c.path("cefr").asText("UNKNOWN"),"SOURCE_BACKED_HIGH_CONFIDENCE",r.path("sourceRefs").toString(),"king-qualified-2",r.path("fingerprint").asText(),"HUMAN_REVIEW_PENDING",null);
    }
    public KingConquestBank.Board board(String id){
        var r=get(id);var c=r.path("content");try{
            return new KingConquestBank.Board(id,strings(c.path("letters")),c.path("seed").asLong(),JSON.treeToValue(c.path("qualityMetrics"),KingConquestBank.Quality.class),
                List.of(JSON.treeToValue(c.path("echoCandidates"),KingConquestBank.Candidate[].class)),"SOURCE_BACKED_HIGH_CONFIDENCE",r.path("sourceRefs").toString(),"king-qualified-2","HUMAN_REVIEW_PENDING",null,r.path("fingerprint").asText());
        }catch(Exception e){throw new IllegalStateException("Invalid King board",e);}
    }
    public List<String> sequence(String mode,int difficulty,int count,long seed){
        var result=new ArrayList<String>();var seen=new HashSet<String>();
        var it=candidates(mode,difficulty,seed);
        while(result.size()<count&&it.hasNext()){var e=it.next();if(seen.add(e.semantic()))result.add(e.id());}
        if(result.isEmpty())throw new KingService.Rejection("CONTENT_UNAVAILABLE");return List.copyOf(result);
    }
    private void buildSelectionIndexes() throws Exception {
        var diversity=new HashMap<String,String>();
        var lexicalCefr=new HashMap<String,Set<String>>();
        var lexicalPos=new HashMap<String,Set<String>>();
        int verified=0;
        for(int shardIndex=0;shardIndex<shards.size();shardIndex++){
            try(var statement=shards.get(shardIndex).createStatement();
                var rs=statement.executeQuery("SELECT id,body FROM content")){
                while(rs.next()){
                    Entry e=index.get(rs.getString(1));
                    if(e==null||e.shard()!=shardIndex)continue;
                    var row=parseAndVerifyRow(e,rs.getString(2));
                    verified++;
                    var c=row.path("content");String answer=c.path("target").asText(c.path("canonical").asText(e.semantic()));
                    // A relation prompt's CEFR belongs to its exact source lexeme, never
                    // automatically to the canonical relation answer (borrow != lend).
                    var refs=new ArrayList<String>();
                    for(var ref:row.path("sourceRefs"))if(ref.path("source").asText().equals("cefrj-vocabulary"))refs.add(ref.path("record").asText());
                    String cefr=c.path("cefr").asText("UNKNOWN");
                    if(refs.size()==1&&Set.of("A1","A2","B1","B2","C1","C2").contains(cefr)&&c.path("difficultySource").asText(e.mode().equals("EXPLAIN")?"CEFR_J":"UNKNOWN").equals("CEFR_J")){
                        String[] parts=refs.getFirst().split(":",2);
                        if(parts.length==2&&lexicon.contains(parts[0])){
                            lexicalCefr.computeIfAbsent(parts[0],k->new TreeSet<>()).add(cefr);
                            lexicalPos.computeIfAbsent(parts[0],k->new TreeSet<>()).add(parts[1]);
                        }
                    }
                    answerKeys.put(e.id(),KingSnapshot.sha(KingBank.normalize(answer).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                    int length=e.mode().equals("REORDER")?c.path("tokens").size():answer.length();
                    diversity.put(e.id(),e.difficulty()+":"+c.path("pos").asText()+":"+Math.min(3,length/4));
                }
            }
        }
        if(verified!=index.size())throw new IllegalStateException("Missing indexed King record");
        for(String mode:modes.keySet())for(int ceiling=0;ceiling<=5;ceiling++){
            var families=new TreeMap<String,Map<String,List<Entry>>>();
            for(var e:entries(mode))if(mode.equals("CONQUEST")||ceiling==0||e.difficulty()<=ceiling)families.computeIfAbsent(e.family(),k->new TreeMap<>()).computeIfAbsent(diversity.get(e.id()),k->new ArrayList<>()).add(e);
            // Family rotation prevents large families dominating; each sub-bucket is then equally weighted.
            var groups=new ArrayList<List<Entry>>();
            int max=families.values().stream().mapToInt(Map::size).max().orElse(0);
            for(int level=0;level<max;level++)for(var family:families.values())if(level<family.size())groups.add(List.copyOf(new ArrayList<>(family.values()).get(level)));
            selectionBuckets.put(mode+":"+ceiling,List.copyOf(groups));
        }
        vocabulary=lexicon.stream().sorted().map(word->new VocabularyWord(word,
            Set.copyOf(lexicalCefr.getOrDefault(word,Set.of())),Set.copyOf(lexicalPos.getOrDefault(word,Set.of())))).toList();
        clearCache();
    }
    String answerKey(Entry e){return answerKeys.getOrDefault(e.id(),e.semantic());}
    Iterator<Entry> candidates(String mode,int difficulty,long seed) {
        if(!enabled())throw new KingService.Rejection("CONTENT_NOT_APPROVED");
        var groups=selectionBuckets.getOrDefault(mode+":"+difficulty,List.of());var rng=new Random(seed);
        // Rotate sub-bucket starts and coprime strides. Every eligible ID is visited once,
        // with O(bucket count) initialization rather than shuffling the whole corpus per match.
        int n=groups.size();int[] offsets=new int[n],steps=new int[n],used=new int[n];
        for(int i=0;i<n;i++){int size=groups.get(i).size();offsets[i]=rng.nextInt(size);int step=1+rng.nextInt(size);while(gcd(step,size)!=1)step=step%size+1;steps[i]=step;}
        return new Iterator<>() {
            int cursor=n==0?0:rng.nextInt(n);Entry next;
            public boolean hasNext(){if(next!=null)return true;for(int checked=0;checked<n;checked++){
                int i=cursor;cursor=(cursor+1)%n;var group=groups.get(i);
                if(used[i]<group.size()){next=group.get((int)((offsets[i]+(long)steps[i]*used[i]++)%group.size()));return true;}
            }return false;}
            public Entry next(){if(!hasNext())throw new NoSuchElementException();var result=next;next=null;return result;}
        };
    }
    private static int gcd(int a,int b){while(b!=0){int c=a%b;a=b;b=c;}return a;}
    @Override @PreDestroy public synchronized void close(){
        for(var db:shards)try{db.close();}catch(SQLException ignored){}shards.clear();clearCache();sourceLockSha256=null;index.clear();modes.clear();lexicon.clear();selectionBuckets.clear();answerKeys.clear();vocabulary=List.of();
        for(var path:temporary)try{Files.deleteIfExists(path);}catch(IOException ignored){}temporary.clear();
    }
}
