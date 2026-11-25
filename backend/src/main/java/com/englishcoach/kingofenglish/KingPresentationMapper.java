package com.englishcoach.kingofenglish;
import java.util.*;
import static com.englishcoach.kingofenglish.KingConfig.*;
import com.englishcoach.kingofenglish.KingService.*;
import java.time.Clock;
/** Private per-viewer presentation; never serializes answer-bank records. */
final class KingPresentationMapper {
    private final KingConquestEngine conquestEngine;private final KingExplainEngine explainEngine;private final KingBank bank;private final Clock clock;
    KingPresentationMapper(KingBank bank,Clock clock,KingExplainEngine explainEngine,KingConquestEngine conquestEngine){this.bank=bank;this.clock=clock;this.explainEngine=explainEngine;this.conquestEngine=conquestEngine;}
    Map<String,Object> snapshot(Room r,long viewer){
        Player p=r.players.get(viewer);var s=new LinkedHashMap<String,Object>();
        s.put("roomCode",r.code);s.put("mode",r.mode);s.put("variant",r.variant);s.put("flow",r.flow);s.put("matchId",r.match.toString());
        s.put("status",r.status);s.put("revision",r.revision);s.put("youId",viewer);s.put("config",KingConfig.publicConfig());
        s.put("championshipRound",r.championshipRound);s.put("championshipTotal",r.championshipTotals.getOrDefault(viewer,0));
        s.put("championshipRounds",List.copyOf(r.championshipRounds));
        s.put("serverTimestamp",clock.millis());s.put("deadline",r.deadline);s.put("winnerId",r.winner);s.put("reason",r.reason);
        s.put("engineering",r.contentChannel.equals("ENGINEERING"));s.put("contentChannel",r.contentChannel);s.put("bot",r.bot);s.put("size",r.size);s.put("difficulty",r.difficulty);s.put("length",r.length);s.put("resultSaved",r.resultSaved);
        s.put("players",r.players.values().stream().map(x->Map.of("id",x.id,"name",x.id==0?"Echo Whale":"Player "+x.id,
            "score",x.score,"wrong",x.wrong,"completed",x.completed,"ready",x.ready,"rematch",x.rematch,"connected",x.disconnected==0)).toList());
        // Echo Sentinel: the viewer's own ranked-attempt state (never the secret, never another player's).
        if(p.sentinel!=null){var a=p.sentinel;var integrity=new LinkedHashMap<String,Object>();
            integrity.put("attemptId",a.id().toString());integrity.put("state",a.state().name());integrity.put("detail",a.detail());s.put("integrity",integrity);}
        else s.put("integrity",null);
        s.put("score",p.score);s.put("wrong",p.wrong);s.put("skipped",p.skipped);s.put("completed",p.completed);
        s.put("responseMs",p.responseMs);s.put("inputRevision",r.mode.equals("CONQUEST")&&r.status.equals("PLAYING")?r.revision:p.revision);s.put("lockUntil",p.lockUntil);s.put("done",p.done);
        int slot=r.mode.equals("CONQUEST")?0:r.mode.equals("EXPLAIN")?r.round:r.mode.equals("REORDER")?r.round:(p.queue.isEmpty()?-1:p.queue.peek());
        s.put("round",slot);s.put("count",!r.mode.equals("REORDER")?r.ids.size():Math.min(!r.flow.equals("SOLO")?REORDER_ROUNDS:r.length,r.ids.size()));
        boolean resolved=r.resolvedAt>0;s.put("resolved",resolved);s.put("revisiting",p.revisiting);
        s.put("challenge",r.status.equals("PLAYING")&&Set.of("REORDER","REFLEX").contains(r.mode)&&slot>=0&&slot<r.ids.size()?bank.presentation(r.ids.get(slot),r.seed+slot,resolved||r.status.equals("FINISHED")):null);
        if(r.status.equals("PLAYING")&&r.mode.equals("REFLEX")&&p.lastSlot>=0&&p.lastSlot<r.ids.size())s.put("lastResult",lastResult(r,p));
        if(r.mode.equals("CONQUEST")&&r.conquest!=null)s.put("conquest",conquestEngine.presentation(r,viewer));
        if(r.mode.equals("EXPLAIN")&&r.explain!=null)s.put("explain",explainEngine.presentation(r,viewer));
        if(r.status.equals("FINISHED")){
            s.put("accuracy",p.completed==0?0:(double)p.correct.size()/p.completed);
            s.put("durationMs",Math.max(0,r.ended-r.started));
            s.put("review",r.mode.equals("CONQUEST")?List.of():r.mode.equals("EXPLAIN")?explainEngine.review(r,p):java.util.stream.IntStream.range(0,Math.min(r.ids.size(),r.mode.equals("REORDER")?r.round+1:r.ids.size()))
                .mapToObj(x->{var item=new LinkedHashMap<String,Object>();item.put("challenge",bank.presentation(r.ids.get(x),r.seed+x,true));
                    item.put("correct",p.correct.contains(x));item.put("submitted",p.submitted.get(x));return (Map<String,Object>)item;}).toList());
        }
        return s;
    }
    /**
     * The viewer's last resolved Reflex slot. The answer and its meaning are disclosed only once no other human player can
     * still answer that slot (both play the same seeded sequence); until then the viewer sees only their own verdict.
     */
    private Map<String,Object> lastResult(Room r,Player p){
        int slot=p.lastSlot;
        boolean revealed=r.players.values().stream().filter(x->x.id!=p.id&&x.id!=0).allMatch(x->x.correct.contains(slot)||x.missed.contains(slot));
        var out=new LinkedHashMap<String,Object>();
        out.put("slot",slot);out.put("correct",p.correct.contains(slot));out.put("skipped",!p.submitted.containsKey(slot));
        out.put("submitted",p.submitted.get(slot));out.put("revealed",revealed);
        out.put("challenge",bank.presentation(r.ids.get(slot),r.seed+slot,revealed));
        return out;
    }
}
