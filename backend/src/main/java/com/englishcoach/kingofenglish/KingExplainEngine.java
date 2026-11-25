package com.englishcoach.kingofenglish;

import java.util.*;
import com.englishcoach.kingofenglish.KingService.*;
import static com.englishcoach.kingofenglish.KingConfig.*;

/** Text meaning game. No room registry, transport, AI, or user prose interpretation. */
final class KingExplainEngine {
    static final class State {
        final List<String> clues=new ArrayList<>();
        final Map<Long,Integer> attempts=new HashMap<>();
        long roundStarted;int clueIndex;
    }
    private final KingExplainBank bank;
    KingExplainEngine(KingExplainBank bank){this.bank=bank;}
    static boolean human(Room r){return r.flow.equals("QUICK_MATCH")||r.flow.equals("PRIVATE_ROOM");}
    static long describer(Room r){return new ArrayList<>(r.players.keySet()).get(r.round%2);}
    void start(Room r,long now){
        if(r.ids.isEmpty())r.ids=bank.sequence(r.difficulty,EXPLAIN_ROUNDS,r.seed,human(r));r.explain=new State();round(r,now);
    }
    private void round(Room r,long now){
        r.explain.clues.clear();r.explain.attempts.clear();r.explain.roundStarted=now;r.explain.clueIndex=0;
        r.resolvedAt=0;r.deadline=now+EXPLAIN_MS;
        r.players.values().forEach(p->{p.shownAt=now;p.lockUntil=0;p.revision++;});
        if(!human(r))r.explain.clues.add(item(r).progressiveClues().getFirst());
        var bot=r.players.get(0L);if(bot!=null)bot.botAt=now+botDelay(r.bot,r.seed,r.round,item(r).difficulty());
    }
    static long botDelay(String profile,long seed,int round,int difficulty){
        int level=switch(profile){case "EASY"->0;case "MEDIUM"->1;case "HARD"->2;case "KING"->3;default->throw new Rejection("INVALID_BOT");};
        long base=switch(level){case 0->36_000L;case 1->12_000L;case 2->8_000L;default->4_000L;};
        return base+difficulty*1_000L+new Random(seed^(round*0x9E3779B9L)).nextInt(2500);
    }
    private KingExplainBank.Item item(Room r){return bank.get(r.ids.get(Math.min(r.round,r.ids.size()-1)));}
    void command(Room r,Player p,Command c,long now){
        if(!KingCommandRules.accept(r,p,c,r.round,p.revision))return;
        if(r.resolvedAt>0)throw new Rejection("ROUND_RESOLVED");
        if(now<p.lockUntil)throw new Rejection("INPUT_LOCKED");
        if(c.action().equals("clue")){
            if(!human(r)||p.id!=describer(r))throw new Rejection("NOT_DESCRIBER");
            if(c.answer()==null||c.answer().isBlank()||c.answer().length()>EXPLAIN_CLUE_MAX)throw new Rejection("INVALID_CLUE");
            if(r.explain.clues.size()>=EXPLAIN_CLUE_CAP)throw new Rejection("CLUE_LIMIT");
            if(KingExplainBank.leaks(item(r),c.answer()))throw new Rejection("TARGET_LEAKAGE");
            String violation=KingCluePolicy.violation(c.answer());
            if(violation!=null)throw new Rejection(violation);
            r.explain.clues.add(c.answer().strip());p.lockUntil=now+500;
        }else if(c.action().equals("answer")){
            if(human(r)&&p.id==describer(r))throw new Rejection("NOT_GUESSER");
            if(c.answer()==null||c.answer().isBlank()||c.answer().length()>160)throw new Rejection("INVALID_ANSWER");
            int attempts=r.explain.attempts.getOrDefault(p.id,0);if(attempts>=EXPLAIN_GUESS_CAP)throw new Rejection("GUESS_LIMIT");
            r.explain.attempts.put(p.id,attempts+1);
            if(KingExplainBank.correct(item(r),c.answer()))resolve(r,p,now);
            else{p.wrong++;p.lockUntil=now+1000;}
        }else throw new Rejection("INVALID_ACTION");
        KingCommandRules.receipt(r,p,c);p.revision++;r.revision++;
    }
    private void resolve(Room r,Player guesser,long now){
        long elapsed=now-r.explain.roundStarted;
        guesser.score+=human(r)?explainGuesserScore(elapsed):explainAuthoredScore(r.explain.clueIndex);
        guesser.correct.add(r.round);guesser.responseMs+=elapsed;
        if(human(r)){var author=r.players.get(describer(r));author.score+=explainDescriberScore(elapsed);author.correct.add(r.round);}
        settle(r,now);
    }
    private void settle(Room r,long now){
        for(var p:r.players.values()){p.completed++;if(!p.correct.contains(r.round))p.missed.add(r.round);}
        r.resolvedAt=now;r.revision++;
    }
    void tick(Room r,long now){
        if(r.resolvedAt>0){
            if(now-r.resolvedAt>=RESOLUTION_MS){
                r.round++;r.revision++;
                if(r.round>=r.ids.size())KingRoundEngine.finish(r,"ROUNDS_COMPLETE",KingRoundEngine.scoreWinner(r),now);
                else round(r,now);
            }return;
        }
        if(now>=r.deadline){settle(r,now);return;}
        if(!human(r)){
            int index=Math.min(2,(int)((now-r.explain.roundStarted)/EXPLAIN_CLUE_INTERVAL));
            while(r.explain.clueIndex<index){r.explain.clueIndex++;r.explain.clues.add(item(r).progressiveClues().get(r.explain.clueIndex));r.revision++;}
            var bot=r.players.get(0L);
            if(bot!=null&&now>=bot.botAt){
                // The same answer predicate and scoring; policy uses authored difficulty/seed only.
                if(KingExplainBank.correct(item(r),item(r).target()))resolve(r,bot,now);
            }
        }
    }
    Map<String,Object> presentation(Room r,long viewer){
        var out=new LinkedHashMap<String,Object>();
        out.put("role",human(r)?(viewer==describer(r)?"DESCRIBER":"GUESSER"):"GUESSER");
        out.put("clues",List.copyOf(r.explain.clues));out.put("clueIndex",r.explain.clueIndex);
        out.put("phase",r.resolvedAt>0?"ROUND_RESULT":"DESCRIBING");
        out.put("guessAttempts",r.explain.attempts.getOrDefault(viewer,0));
        if(human(r)&&viewer==describer(r)||r.resolvedAt>0||r.status.equals("FINISHED")){
            out.put("target",item(r).target());out.put("meaning",item(r).meaning());
            if(r.resolvedAt==0&&!r.status.equals("FINISHED"))out.put("forbiddenForms",item(r).forbiddenForms());
        }
        return out;
    }
    List<Map<String,Object>> review(Room r,Player p){
        return java.util.stream.IntStream.range(0,Math.min(p.completed,r.ids.size())).mapToObj(n->{
            var i=bank.get(r.ids.get(n));return Map.<String,Object>of("challenge",Map.of("answer",i.target(),"meaning",i.meaning()),"correct",p.correct.contains(n));
        }).toList();
    }
}
