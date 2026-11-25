package com.englishcoach.kingofenglish;
import java.util.*;
import com.englishcoach.kingofenglish.KingService.*;
/** Shared receipt/revision rules, invoked only after coordinator membership/session/rate checks. */
final class KingCommandRules {
    static boolean accept(Room r,Player p,Command c,int round,long revision){
        if(!r.match.toString().equals(c.matchId()))throw new Rejection("STALE_MATCH");
        if(c.messageId()==null||!c.messageId().matches("[A-Za-z0-9-]{1,64}"))throw new Rejection("INVALID_RECEIPT");
        if(r.receipts.contains(p.id+":"+c.messageId()))return false;
        if(!r.status.equals("PLAYING"))throw new Rejection("NOT_PLAYING");
        if(!Objects.equals(c.round(),round)||!Objects.equals(c.revision(),revision))throw new Rejection("STALE_ROUND");
        return true;
    }
    /**
     * Soán ngôi: whether a path is a word depends only on the letters and the used set, both read under the room lock when the
     * command runs, never on what the sender had seen. A word sent a moment after another (yours or your opponent's) is simply
     * the next move; a retried message ends at its receipt, so it never scores twice.
     */
    static boolean acceptMove(Room r,Player p,Command c){
        if(!r.match.toString().equals(c.matchId()))throw new Rejection("STALE_MATCH");
        if(c.messageId()==null||!c.messageId().matches("[A-Za-z0-9-]{1,64}"))throw new Rejection("INVALID_RECEIPT");
        if(r.receipts.contains(p.id+":"+c.messageId()))return false;
        if(!r.status.equals("PLAYING"))throw new Rejection("NOT_PLAYING");
        return true;
    }
    static void receipt(Room r,Player p,Command c){
        r.receipts.add(p.id+":"+c.messageId());
        while(r.receipts.size()>KingConfig.RECEIPT_CAP)r.receipts.remove(r.receipts.iterator().next());
    }
}
