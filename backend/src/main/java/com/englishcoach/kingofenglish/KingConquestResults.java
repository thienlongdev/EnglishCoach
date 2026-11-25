package com.englishcoach.kingofenglish;

import com.englishcoach.leaderboard.board.LeaderboardDisplayRepository;
import com.englishcoach.sentinel.SentinelAttempt;
import com.englishcoach.sentinel.SentinelService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/**
 * Soán ngôi results (V105): written by ONE background writer from the server's own room state (never a client number, never
 * under the room lock), read for the per-size Top 5 and the learner's own best. Ranked: ACTIVE learners only (no
 * administrator, no excluded test account); the learner always sees their own best.
 */
@Service
public class KingConquestResults {
    /** {@code verified}: the Echo Sentinel completion of this row's attempt (V119); null only where no Sentinel runs (unit tests). */
    public record Row(UUID match,long user,int size,String flow,int score,int words,int territory,boolean throne,Boolean won,Instant at,
                      SentinelAttempt.Change verified) {
        public Row(UUID match,long user,int size,String flow,int score,int words,int territory,boolean throne,Boolean won,Instant at){
            this(match,user,size,flow,score,words,territory,throne,won,at,null);
        }
        String category(){return flow.equals("SOLO")?"SOLO":"DUEL";}
        UUID attempt(){return verified==null?null:verified.attempt().id();}
    }
    private SentinelService sentinel;
    @org.springframework.beans.factory.annotation.Autowired(required=false) void setSentinel(SentinelService sentinel){this.sentinel=sentinel;}
    private final JdbcTemplate jdbc;
    private final ObjectProvider<LeaderboardDisplayRepository> display;
    private final ThreadPoolExecutor writer=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(512),r->{
        var t=new Thread(r,"king-conquest-results");t.setDaemon(true);return t;});
    public KingConquestResults(JdbcTemplate jdbc,ObjectProvider<LeaderboardDisplayRepository> display){this.jdbc=jdbc;this.display=display;}

    /** Queues the rows; {@code done} receives whether they were stored. Never blocks the caller; a full queue reports false. */
    void submit(List<Row> rows,java.util.function.Consumer<Boolean> done){
        try{
            writer.execute(()->{
                boolean ok;
                try{save(rows);ok=true;}catch(Exception e){ok=false;}
                done.accept(ok);
            });
        }catch(RejectedExecutionException e){done.accept(false);}
    }
    void save(List<Row> rows){
        for(var r:rows){
            // The attempt is stored as verified BEFORE its ranked row; the V119 trigger refuses a row whose attempt is not.
            if(r.verified()!=null&&sentinel!=null)sentinel.persist(r.verified());
            jdbc.update("""
            INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,won,finished_at,sentinel_attempt_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (match_id,user_id) DO NOTHING
            """,r.match(),r.user(),r.size(),r.category(),r.flow(),r.score(),r.words(),r.territory(),r.throne(),r.won(),Timestamp.from(r.at()),r.attempt());
        }
    }

    /** Top 5 learners (best score each) of one board size and category, plus the viewer's best and rank. */
    public Map<String,Object> board(long viewer,int size,String category){
        KingConfig.conquestMs(size);
        if(!Set.of("SOLO","DUEL").contains(category))throw new KingService.Rejection("INVALID_CATEGORY");
        var best=jdbc.query("""
            SELECT b.user_id,b.score,b.finished_at FROM (
              SELECT DISTINCT ON (r.user_id) r.user_id,r.score,r.finished_at FROM public.king_conquest_results r
              JOIN public.users u ON u.id=r.user_id AND u.role<>'ROLE_ADMIN' AND u.account_status='ACTIVE'
              WHERE r.board_size=? AND r.category=? ORDER BY r.user_id,r.score DESC,r.finished_at ASC) b
            ORDER BY b.score DESC,b.finished_at ASC LIMIT 12
            """,(rs,i)->new Object[]{rs.getLong(1),rs.getInt(2),rs.getTimestamp(3).toInstant()},size,category);
        var repository=display.getIfAvailable();
        var shown=repository==null?Map.<Long,LeaderboardDisplayRepository.Display>of():repository.find(best.stream().map(x->(Long)x[0]).toList());
        var top=new ArrayList<Map<String,Object>>();
        for(var row:best){
            long user=(Long)row[0];var d=shown.get(user);
            if(d!=null&&d.excluded())continue;
            if(top.size()==5)break;
            var item=new LinkedHashMap<String,Object>();
            item.put("rank",top.size()+1);item.put("name",d==null?"Học viên #"+user:d.displayName());
            item.put("avatarUrl",d==null?null:d.avatarUrl());item.put("score",row[1]);item.put("achievedAt",row[2].toString());item.put("you",user==viewer);
            top.add(item);
        }
        var mine=jdbc.query("""
            SELECT score,finished_at FROM public.king_conquest_results WHERE user_id=? AND board_size=? AND category=?
            ORDER BY score DESC,finished_at ASC LIMIT 1
            """,(rs,i)->new Object[]{rs.getInt(1),rs.getTimestamp(2).toInstant()},viewer,size,category);
        var out=new LinkedHashMap<String,Object>();
        out.put("size",size);out.put("category",category);out.put("top",top);
        if(mine.isEmpty())out.put("you",null);
        else{
            int score=(Integer)mine.getFirst()[0];
            Integer above=jdbc.queryForObject("""
                SELECT count(*) FROM (SELECT r.user_id FROM public.king_conquest_results r
                  JOIN public.users u ON u.id=r.user_id AND u.role<>'ROLE_ADMIN' AND u.account_status='ACTIVE'
                  WHERE r.board_size=? AND r.category=? AND r.user_id<>? GROUP BY r.user_id HAVING max(r.score)>?) x
                """,Integer.class,size,category,viewer,score);
            Boolean ranked=jdbc.queryForObject("SELECT role<>'ROLE_ADMIN' AND account_status='ACTIVE' FROM public.users WHERE id=?",Boolean.class,viewer);
            var you=new LinkedHashMap<String,Object>();
            you.put("best",score);you.put("achievedAt",mine.getFirst()[1].toString());
            you.put("rank",Boolean.TRUE.equals(ranked)?(above==null?0:above)+1:null);
            out.put("you",you);
        }
        return out;
    }
}
