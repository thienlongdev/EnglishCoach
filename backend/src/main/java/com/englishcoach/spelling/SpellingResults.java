package com.englishcoach.spelling;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import static com.englishcoach.spelling.SpellingProtocol.*;

/** Immutable completion receipts. Personal reads always carry the authenticated owner. */
@Repository
public class SpellingResults {
    public record Seal(long user, Run run, UUID sentinel, boolean eligible) {}
    private final JdbcTemplate jdbc;private final ObjectMapper json;private final TransactionTemplate tx;
    public SpellingResults(JdbcTemplate jdbc,ObjectMapper json,PlatformTransactionManager transactions){this.jdbc=jdbc;this.json=json;tx=new TransactionTemplate(transactions);}
    public String name(long user){
        var rows=jdbc.query("SELECT COALESCE(NULLIF(p.display_name,''),NULLIF(u.name,''),'Learner') FROM public.users u LEFT JOIN public.user_profiles p ON p.user_id=u.id WHERE u.id=?",
            (rs,i)->rs.getString(1),user);
        String name=rows.isEmpty()?"Learner":rows.getFirst();return name.substring(0,Math.min(32,name.length()));
    }
    public List<String> save(Seal seal){
        return tx.execute(status->{
            jdbc.queryForObject("SELECT 1 FROM (SELECT pg_advisory_xact_lock(?)) lock",Integer.class,5_700_000_000L+seal.user);
            Run r=seal.run;Best before=best(seal.user).stream().filter(b->b.mode().equals(r.mode())&&b.difficulty().equals(r.difficulty())).findFirst().orElse(null);
            int inserted=jdbc.update("""
                INSERT INTO public.spelling_results(match_id,user_id,mode,difficulty,rules_version,score,correct,wrong,max_streak,
                  highest_wpm,accuracy,duration_ms,won,eligible,integrity,sentinel_attempt_id,finished_at,review)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT (match_id,user_id) DO NOTHING
                """,r.matchId(),seal.user,r.mode(),r.difficulty(),SpellingRules.VERSION,r.score(),r.correct(),r.wrong(),r.maxStreak(),
                r.highestWpm(),r.accuracy(),r.durationMs(),r.won(),seal.eligible,r.integrity(),seal.sentinel,Timestamp.from(Instant.parse(r.finishedAt())),encode(r.review()));
            if(inserted==0||!seal.eligible&&!r.mode().equals("PRACTICE")||r.correct()==0)return List.of();
            var records=new ArrayList<String>();
            if(before==null||r.score()>before.highestScore())records.add("SCORE");
            if(before==null||r.maxStreak()>before.longestStreak())records.add("STREAK");
            if(before==null||r.correct()>before.mostCorrect())records.add("WORDS");
            if(before==null||r.highestWpm()>before.highestWpm())records.add("WPM");
            if(before==null||r.accuracy()>before.bestAccuracy())records.add("ACCURACY");
            if(r.mode().equals("ENDLESS")&&(before==null||r.durationMs()>before.bestSurvivalMs()))records.add("SURVIVAL");
            return List.copyOf(records);
        });
    }
    public Records records(long user){
        List<Run> recent=jdbc.query("SELECT * FROM public.spelling_results WHERE user_id=? ORDER BY finished_at DESC LIMIT 20",(rs,i)->
            new Run(rs.getObject("match_id",UUID.class),rs.getString("mode"),rs.getString("difficulty"),rs.getInt("score"),rs.getInt("correct"),rs.getInt("wrong"),rs.getInt("max_streak"),
                rs.getDouble("highest_wpm"),rs.getDouble("accuracy"),rs.getLong("duration_ms"),rs.getBoolean("won"),rs.getString("integrity"),rs.getTimestamp("finished_at").toInstant().toString(),decode(rs.getString("review"))),user);
        return new Records(best(user),recent);
    }
    List<Best> best(long user){
        return jdbc.query("""
            SELECT mode,difficulty,COALESCE(max(score) FILTER (WHERE eligible OR mode='PRACTICE'),0) score,
              COALESCE(max(max_streak) FILTER (WHERE eligible OR mode='PRACTICE'),0) streak,COALESCE(max(correct) FILTER (WHERE eligible OR mode='PRACTICE'),0) correct,
              COALESCE(max(highest_wpm) FILTER (WHERE eligible OR mode='PRACTICE'),0) wpm,COALESCE(max(accuracy) FILTER (WHERE (eligible OR mode='PRACTICE') AND correct>0),0) accuracy,
              COALESCE(max(duration_ms) FILTER (WHERE (eligible OR mode='PRACTICE') AND correct>0),0) survival,count(*) attempts,
              count(*) FILTER (WHERE eligible AND won) wins
            FROM public.spelling_results WHERE user_id=? GROUP BY mode,difficulty ORDER BY mode,difficulty
            """,(rs,i)->new Best(rs.getString(1),rs.getString(2),rs.getInt(3),rs.getInt(4),rs.getInt(5),rs.getDouble(6),rs.getDouble(7),rs.getLong(8),rs.getLong(9),rs.getLong(10)),user);
    }
    public List<Map<String,Object>> leaderboard(String difficulty){
        SpellingRules.Difficulty.valueOf(difficulty);
        return jdbc.queryForList("""
            SELECT r.user_id,COALESCE(NULLIF(p.display_name,''),NULLIF(u.name,''),'Learner') name,
              count(*) FILTER (WHERE r.won) wins,sum(r.correct) correct,max(r.score) score,max(r.highest_wpm) wpm
            FROM public.spelling_results r JOIN public.users u ON u.id=r.user_id
              LEFT JOIN public.user_profiles p ON p.user_id=r.user_id
            WHERE r.eligible AND r.mode='MULTIPLAYER' AND r.difficulty=? AND u.role<>'ROLE_ADMIN' AND u.account_status='ACTIVE'
            GROUP BY r.user_id,u.name,p.display_name ORDER BY wins DESC,correct DESC,r.user_id LIMIT 50
            """,difficulty);
    }
    private String encode(Object value){try{return json.writeValueAsString(value);}catch(Exception e){throw new IllegalStateException("Cannot encode spelling result",e);}}
    private List<Review> decode(String value){try{return json.readValue(value,new TypeReference<List<Review>>(){});}catch(Exception e){throw new IllegalStateException("Invalid stored spelling result",e);}}
}
