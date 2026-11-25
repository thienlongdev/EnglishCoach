package com.englishcoach.kingofenglish;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import com.englishcoach.kingofenglish.KingService.*;
import java.util.*;
import static com.englishcoach.kingofenglish.KingConfig.*;

/** Tactical territory rules under the shared King coordinator lock, on a 4×4 to 7×7 board. */
final class KingConquestEngine {
    record AcceptedMove(long playerId,String word,List<Integer> path,int wordPoints,int territoryAfter,
                        boolean throneAfter,int scoreAfter,int sequence) {}
    static final class State {
        String boardId,lastWord="";long lastPlayer=-1;
        final int size,throne;
        final long[] owners;
        /** The board of this match (bank board for 5×5, generated board otherwise) and Echo's bounded candidates. */
        List<String> letters=List.of();List<KingConquestBank.Candidate> candidates=List.of();
        final Set<String> used=new LinkedHashSet<>();
        final Map<Long,Integer> wordPoints=new HashMap<>(),longest=new HashMap<>();
        final List<AcceptedMove> history=new ArrayList<>();
        List<Integer> lastPath=List.of();
        State(){this(CONQUEST_DEFAULT_SIZE,12);}
        State(int size,int throne){this.size=size;this.throne=throne;owners=new long[size*size];Arrays.fill(owners,-1);}
    }
    private final KingConquestBank bank;private final LocalGameLexicon lexicon;
    KingConquestEngine(KingConquestBank bank,LocalGameLexicon lexicon){this.bank=bank;this.lexicon=lexicon;this.meanings=Glosses.TABLE;}
    // Immutable presentation data prepared offline from the bundled EN–VI dictionary.
    // Initialized with the engine, before admission. Never consulted by validation or scoring.
    private final Map<String,String> meanings;
    private static final class Glosses {
        static final Map<String,String> TABLE = load();
        private static Map<String,String> load() {
            var entries = new HashMap<String,String>();
            try (var input = KingConquestEngine.class.getResourceAsStream("/data/king/conquest-vi.tsv.gz")) {
                if (input != null) try (var reader = new java.io.BufferedReader(new java.io.InputStreamReader(
                        new java.util.zip.GZIPInputStream(input), java.nio.charset.StandardCharsets.UTF_8))) {
                    for (String line; (line=reader.readLine())!=null;) {
                        int tab=line.indexOf('\t'); if(tab>0) entries.put(line.substring(0,tab),line.substring(tab+1));
                    }
                }
            } catch(java.io.IOException ignored) { return Map.of(); }
            return Map.copyOf(entries);
        }
    }
    private boolean artifact(){return bank.corpus()!=null&&bank.corpus().artifactBacked();}
    boolean available(){return artifact()||lexicon!=null&&lexicon.available();}
    /** Accepted words: the King learner lexicon (or the local dictionary) plus every ordinary SCOWL form — one rule for humans and Echo. */
    boolean eligible(String word){
        if(KingConquestBoards.words().contains(word))return true;
        return artifact()?bank.corpus().wordEligible(word):lexicon!=null&&lexicon.lookupConquest(word).isPresent();
    }
    private KingConquestBoards.Words commonWords(){
        return artifact()?new KingConquestBoards.Words(bank.corpus().lexiconWords()):KingConquestBoards.words();
    }
    private volatile KingConquestBoards.Words common;
    /**
     * Generated boards wait here, made on their own low-priority thread: solving a 7×7 board takes far too long for the one lock
     * every King room and command shares. An empty shelf (a first match right after start-up, tests) falls back to generating here.
     */
    private final Map<Integer,Queue<KingConquestBoards.Generated>> shelf=new java.util.concurrent.ConcurrentHashMap<>();
    private volatile java.util.concurrent.Executor boardMaker;
    static final int SHELF_BOARDS=3;
    void startBoardMaker(java.util.concurrent.Executor maker){boardMaker=maker;maker.execute(this::fillShelf);}
    private void fillShelf(){
        try{
            if(!available())return;
            var all=KingConquestBoards.words();if(common==null)common=commonWords();
            for(int size:CONQUEST_GENERATED_SIZES){
                var queue=shelf.computeIfAbsent(size,k->new java.util.concurrent.ConcurrentLinkedQueue<>());
                while(queue.size()<SHELF_BOARDS)queue.add(KingConquestBoards.generate(size,java.util.concurrent.ThreadLocalRandom.current().nextLong(),all,common));
            }
        }catch(RuntimeException ignored){/* the next match generates its own board */}
    }
    private KingConquestBoards.Generated board(int size,long seed){
        var queue=shelf.get(size);var ready=queue==null?null:queue.poll();
        var maker=boardMaker;if(ready!=null&&maker!=null)maker.execute(this::fillShelf);
        if(ready!=null)return ready;
        if(common==null)common=commonWords();
        return KingConquestBoards.generate(size,seed,KingConquestBoards.words(),common);
    }
    void start(Room r,long now){
        if(!available())throw new Rejection("LEXICON_UNAVAILABLE");
        int size=r.size;
        if(size==CONQUEST_DEFAULT_SIZE){
            String board=r.ids.isEmpty()?bank.select(r.seed):r.ids.getFirst();var b=bank.get(board);
            r.conquest=new State();r.conquest.boardId=board;r.conquest.letters=b.letters();r.conquest.candidates=b.echoCandidates();
        }else{
            var g=board(size,r.seed);
            r.conquest=new State(size,g.throne());r.conquest.boardId="GEN-"+size+"-"+Long.toHexString(r.seed);
            r.conquest.letters=g.letters();r.conquest.candidates=g.candidates();
        }
        r.ids=List.of();r.deadline=now+conquestMs(size);
        var bot=r.players.get(0L);if(bot!=null)bot.botAt=now+botDelay(r.bot,r.seed,0);
    }
    static long botDelay(String profile,long seed,int moves){
        int level=switch(profile){case "EASY"->0;case "MEDIUM"->1;case "HARD"->2;case "KING"->3;default->throw new Rejection("INVALID_BOT");};
        return 9000-level*1800L+new Random(seed^moves).nextInt(1200);
    }
    void command(Room r,Player p,Command c,long now){
        if(!c.action().equals("move"))throw new Rejection("INVALID_ACTION");
        if(!KingCommandRules.acceptMove(r,p,c))return;
        move(r,p,c.answer(),c.order(),now);KingCommandRules.receipt(r,p,c);
    }
    private void move(Room r,Player p,String word,List<Integer> path,long now){
        var state=r.conquest;
        String normalized=KingConquestRules.validate(state.letters,state.size,word,path,state.used,this::eligible);
        int beforeWordPoints=state.wordPoints.getOrDefault(p.id,0);
        state.used.add(normalized);for(int cell:path)state.owners[cell]=p.id;
        // No ceiling: every new valid word adds its points, whatever the total or the record already is.
        state.wordPoints.merge(p.id,conquestWordPoints(normalized.length()),Integer::sum);
        state.longest.merge(p.id,normalized.length(),Math::max);state.lastWord=normalized;state.lastPath=List.copyOf(path);state.lastPlayer=p.id;
        p.completed++;p.correct.add(p.completed-1);r.revision++;refreshScores(r);
        state.history.add(new AcceptedMove(p.id,normalized,List.copyOf(path),state.wordPoints.getOrDefault(p.id,0)-beforeWordPoints,
            territory(r,p.id),state.owners[state.throne]==p.id,p.score,state.history.size()+1));
        if(state.used.size()>=CONQUEST_WORD_CAP)KingRoundEngine.finish(r,"WORD_LIMIT",KingRoundEngine.scoreWinner(r),now);
    }
    private void refreshScores(Room r){
        for(var p:r.players.values())p.score=score(r,p.id);
    }
    static int score(Room r,long player){
        var c=r.conquest;return c.wordPoints.getOrDefault(player,0)+territory(r,player)*CONQUEST_TERRITORY_POINT+(c.owners[c.throne]==player?CONQUEST_THRONE_BONUS:0);
    }
    static int territory(Room r,long player){return (int)Arrays.stream(r.conquest.owners).filter(owner->owner==player).count();}
    void tick(Room r,long now){
        if(now>=r.deadline){refreshScores(r);KingRoundEngine.finish(r,"TIMEOUT",KingRoundEngine.scoreWinner(r),now);return;}
        var bot=r.players.get(0L);if(bot==null||now<bot.botAt)return;
        var state=r.conquest;
        var candidates=state.candidates.stream().filter(c->!state.used.contains(c.word())).toList();
        int level=switch(r.bot){case "EASY"->0;case "MEDIUM"->1;case "HARD"->2;default->3;};
        Comparator<KingConquestBank.Candidate> preference=Comparator.comparingInt(c->
            level==0?-c.word().length():c.word().length()+c.path().stream().mapToInt(i->state.owners[i]!=0?(level==1?1:2):0).sum()+(level==3&&c.path().contains(state.throne)?8:0));
        var ranked=new ArrayList<>(candidates);Collections.shuffle(ranked,new Random(r.seed^state.used.size()));ranked.sort(preference.reversed());
        for(var c:ranked)try{move(r,bot,c.word(),c.path(),now);break;}catch(Rejection ignored){/* bounded candidates; no bot-only acceptance */}
        bot.botAt=now+botDelay(r.bot,r.seed,state.used.size());
    }
    Map<String,Object> presentation(Room r,long viewer){
        var c=r.conquest;var out=new LinkedHashMap<String,Object>();
        out.put("boardId",c.boardId);out.put("size",c.size);out.put("durationMs",conquestMs(c.size));
        out.put("letters",c.letters);out.put("owners",Arrays.stream(c.owners).boxed().toList());
        out.put("throne",c.throne);out.put("territory",territory(r,viewer));out.put("longestWord",c.longest.getOrDefault(viewer,0));
        out.put("wordPoints",c.wordPoints.getOrDefault(viewer,0));out.put("usedWords",List.copyOf(c.used));
        out.put("yourUsedWordCount",c.history.stream().filter(x->x.playerId()==viewer).count());
        out.put("opponentUsedWordCount",c.history.stream().filter(x->x.playerId()!=viewer).count());
        out.put("wordHistory",c.history.stream().map(x->Map.of(
            "sequence",x.sequence(),"playerId",x.playerId(),"word",x.word(),"path",x.path(),
            "wordPoints",x.wordPoints(),"territoryAfter",x.territoryAfter(),
            "meaningVi",meanings.getOrDefault(x.word(),""),"throneAfter",x.throneAfter(),"scoreAfter",x.scoreAfter())).toList());
        var breakdown=new LinkedHashMap<String,Object>();
        for(var player:r.players.values()){
            breakdown.put(Long.toString(player.id),Map.of("wordCount",c.history.stream().filter(x->x.playerId()==player.id).count(),
                "wordPoints",c.wordPoints.getOrDefault(player.id,0),"territory",territory(r,player.id),
                "throne",c.owners[c.throne]==player.id,"longestWord",c.longest.getOrDefault(player.id,0),"score",score(r,player.id)));
        }
        out.put("playerBreakdown",breakdown);
        out.put("lastWord",c.lastWord);out.put("lastPath",c.lastPath);out.put("lastPlayer",c.lastPlayer);return out;
    }
}
