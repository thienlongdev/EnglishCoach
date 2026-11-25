package com.englishcoach.kingofenglish;
import java.util.*;
import static com.englishcoach.kingofenglish.KingConfig.*;
import com.englishcoach.kingofenglish.KingService.*;
/** Reorder/Reflex gameplay only; called under the coordinator lock. Owns no rooms or transport. */
final class KingRoundEngine {
    private final KingBank bank;
    KingRoundEngine(KingBank bank){this.bank=bank;}
    static KingService.BotDecision botDecision(String profile,long seed,int slot,int difficulty,int tokenCount){
        int level=switch(profile){case "EASY"->0;case "MEDIUM"->1;case "HARD"->2;case "KING"->3;default->throw new Rejection("INVALID_BOT");};
        var rng=new Random(seed ^ (slot*0x9E3779B9L));
        long delay=(5000-level*1100L)+(difficulty*500L)+(tokenCount*80L)+rng.nextInt(700);
        double accuracy=Math.max(.25,.62+level*.11-difficulty*.035);
        return new KingService.BotDecision(delay,rng.nextDouble()<accuracy);
    }
    boolean versus(Room r){return !r.flow.equals("SOLO");}
    void planBot(Room r,Player p,long now){
        if(p.id!=0||p.queue.isEmpty())return;
        var i=bank.get(r.ids.get(r.mode.equals("REORDER")?r.round:p.queue.peek()));
        p.botAt=now+botDecision(r.bot,r.seed,r.mode.equals("REORDER")?r.round:p.queue.peek(),i.difficulty(),i.tokens().size()).delay();
    }
    void answer(Room r,Player p,Command c,long now){
        if(!r.match.toString().equals(c.matchId()))throw new Rejection("STALE_MATCH");
        if(c.messageId()==null||!c.messageId().matches("[A-Za-z0-9-]{1,64}"))throw new Rejection("INVALID_RECEIPT");
        String key=p.id+":"+c.messageId();
        if(r.receipts.contains(key))return;
        if(!r.status.equals("PLAYING"))throw new Rejection("NOT_PLAYING");
        int slot=r.mode.equals("REORDER")?r.round:(p.queue.isEmpty()?-1:p.queue.peek());
        if(!Objects.equals(c.round(),slot)||!Objects.equals(c.revision(),p.revision))throw new Rejection("STALE_ROUND");
        if(now<p.lockUntil)throw new Rejection("INPUT_LOCKED");
        if(c.answer()!=null&&c.answer().length()>160||c.order()!=null&&c.order().size()>24)throw new Rejection("INVALID_ANSWER");
        if(c.action().equals("skip")&&r.mode.equals("REORDER")&&versus(r))throw new Rejection("SKIP_NOT_ALLOWED");
        boolean resolved=r.mode.equals("REORDER")&&r.resolvedAt>0;
        if(c.action().equals("next")){
            if(!r.mode.equals("REORDER")||versus(r)||!resolved)throw new Rejection("INVALID_NEXT");
            receipt(r,key);nextRound(r,now);return;
        }
        if(resolved||p.done)throw new Rejection("ROUND_RESOLVED");
        receipt(r,key);
        if(c.action().equals("skip")){
            if(r.mode.equals("REORDER")||!p.revisiting)p.skipped++;
            if(r.mode.equals("REORDER")){
                p.completed++;p.missed.add(slot);r.resolvedAt=now;
            }else{
                if(!p.revisiting)p.deferred.add(p.queue.peek());else{p.completed++;p.missed.add(slot);p.lastSlot=slot;}
                advance(r,p,now);
            }
        }else{
            var item=bank.get(r.ids.get(slot));boolean correct=KingBank.correct(item,c.answer(),c.order());
            p.submitted.put(slot,submitted(item,c));if(r.mode.equals("REFLEX"))p.lastSlot=slot;
            if(r.mode.equals("REORDER")){
                if(correct){p.score+=versus(r)?1:10;p.completed++;p.correct.add(slot);p.responseMs+=now-p.shownAt;r.resolvedAt=now;}
                else{p.wrong++;p.lockUntil=now+WRONG_LOCK_MS;}
            }else{
                p.completed++;if(correct){p.score++;p.correct.add(slot);p.responseMs+=Math.max(0,now-p.shownAt);}
                else{p.wrong++;p.missed.add(slot);}
                advance(r,p,now);
            }
        }
        r.revision++;
        if(r.mode.equals("REFLEX")&&r.players.values().stream().allMatch(x->x.done))finish(r,"QUEUE_COMPLETE",reflexWinner(r),now);
    }
    /** What the learner actually submitted, as text: their tile order joined like the answer, or their typed/selected answer. */
    static String submitted(KingBank.Item item,Command c){
        var order=c.order();var tokens=item.tokens();
        if(!tokens.isEmpty()&&order!=null&&!order.isEmpty()&&order.stream().allMatch(x->x!=null&&x>=0&&x<tokens.size()))
            return String.join(item.mode().equals("REORDER")?" ":"",order.stream().map(tokens::get).toList());
        String answer=Objects.toString(c.answer(),"").strip();
        return answer.length()>160?answer.substring(0,160):answer;
    }
    void receipt(Room r,String key){r.receipts.add(key);while(r.receipts.size()>RECEIPT_CAP)r.receipts.remove(r.receipts.iterator().next());}
    void advance(Room r,Player p,long now){
        p.queue.poll();
        if(p.queue.isEmpty()&&!p.deferred.isEmpty()){p.queue.addAll(p.deferred);p.deferred.clear();p.revisiting=true;}
        p.done=p.queue.isEmpty();p.revision++;p.shownAt=now;planBot(r,p,now);
    }
    void nextRound(Room r,long now){
        // Both players complete every resolved round, including losses and timeouts.
        for(var p:r.players.values())if(!p.correct.contains(r.round)&&!p.missed.contains(r.round)){
            p.completed++;p.missed.add(r.round);
        }
        r.round++;
        int normal=Math.min(versus(r)?REORDER_ROUNDS:r.length,r.ids.size());
        boolean tied=r.players.values().stream().map(p->p.score).distinct().count()==1;
        if(r.round>=normal&&(!versus(r)||!tied||r.round>=Math.min(normal+SUDDEN_MAX,r.ids.size()))){finish(r,"ROUNDS_COMPLETE",scoreWinner(r),now);return;}
        r.resolvedAt=0;r.deadline=now+REORDER_MS;r.revision++;
        for(var p:r.players.values()){p.lockUntil=0;p.shownAt=now;p.revision++;planBot(r,p,now);}
    }
    static Long scoreWinner(Room r){
        return r.players.values().stream().max(Comparator.comparingInt(p->p.score)).filter(p->
            r.players.values().stream().filter(x->x.score==p.score).count()==1).map(p->p.id).orElse(null);
    }
    Long reflexWinner(Room r){
        Comparator<Player> rank=Comparator.comparingInt((Player p)->p.score).thenComparingInt(p->-p.wrong).thenComparingLong(p->-p.responseMs);
        var ordered=r.players.values().stream().sorted(rank.reversed()).toList();
        return ordered.size()<2||rank.compare(ordered.get(0),ordered.get(1))==0?null:ordered.get(0).id;
    }
    static void finish(Room r,String reason,Long winner,long now){
        if(r.status.equals("FINISHED"))return;r.status="FINISHED";r.reason=reason;r.winner=winner;r.ended=now;r.revision++;
        r.players.values().forEach(p->p.botAt=0);
    }
    void tick(Room r,long now){
                if(now>=r.deadline){
                    if(r.mode.equals("REFLEX"))finish(r,"TIMEOUT",reflexWinner(r),now);
                    else if(r.resolvedAt==0){
                        for(var p:r.players.values()){p.completed++;p.missed.add(r.round);}
                        r.resolvedAt=now;r.revision++;
                    }
                }
                if(r.status.equals("PLAYING")&&r.mode.equals("REORDER")&&r.resolvedAt>0&&
                    (versus(r)&&now-r.resolvedAt>=RESOLUTION_MS||!versus(r)&&now-r.resolvedAt>=FINISH_TTL))nextRound(r,now);
                Player bot=r.players.get(0L);
                if(r.status.equals("PLAYING")&&bot!=null&&!bot.done&&now>=bot.botAt&&
                    (r.mode.equals("REFLEX")||r.resolvedAt==0)){
                    int slot=r.mode.equals("REORDER")?r.round:bot.queue.peek();var item=bank.get(r.ids.get(slot));
                    var decision=botDecision(r.bot,r.seed,slot,item.difficulty(),item.tokens().size());
                    boolean correct=decision.correct();
                    if(r.mode.equals("REORDER")){
                        if(correct){bot.score++;bot.completed++;bot.correct.add(slot);bot.responseMs+=Math.max(0,now-bot.shownAt);r.resolvedAt=now;}
                        else{bot.wrong++;bot.botAt=r.deadline+1;}
                    }else{
                        bot.completed++;if(correct){bot.score++;bot.correct.add(slot);bot.responseMs+=Math.max(0,now-bot.shownAt);}else{bot.wrong++;bot.missed.add(slot);}
                        advance(r,bot,now);
                        if(r.players.values().stream().allMatch(p->p.done))finish(r,"QUEUE_COMPLETE",reflexWinner(r),now);
                    }r.revision++;
                }
    }
}
