package com.englishcoach.kingofenglish;

import com.englishcoach.leaderboard.board.LeaderboardDisplayRepository;
import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.*;

/** V105 + V113 + V119 on PostgreSQL 17: one row per player per match, best score per learner, sizes / categories apart, admin never ranked. */
class KingConquestResultsPostgresTest {
    static PostgreSQLContainer<?> pg;static JdbcTemplate sql;static KingConquestResults results;
    @BeforeAll static void start()throws Exception{
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(),"Docker not available");
        pg=new PostgreSQLContainer<>("postgres:17");pg.start();
        sql=new JdbcTemplate(new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword()));
        sql.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, role VARCHAR(32) NOT NULL DEFAULT 'ROLE_USER', account_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE');"
            +" INSERT INTO public.users(id) SELECT g FROM generate_series(1, 20) g; UPDATE public.users SET role='ROLE_ADMIN' WHERE id=9; UPDATE public.users SET account_status='DISABLED' WHERE id=10;");
        for(var m:List.of("V105__king_conquest_results.sql","V113__king_conquest_unlimited_score.sql","V119__echo_sentinel_attempts.sql"))
            sql.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/"+m)));
        @SuppressWarnings("unchecked") ObjectProvider<LeaderboardDisplayRepository> none=mock(ObjectProvider.class);
        results=new KingConquestResults(sql,none);
        sentinel=new SentinelService(new SentinelStore(sql),java.time.Clock.systemUTC());results.setSentinel(sentinel);
    }
    static SentinelService sentinel;
    @AfterAll static void stop(){if(sentinel!=null)sentinel.close();if(pg!=null)pg.stop();}
    /** Since V119 a ranked row is written only with a verified Echo Sentinel attempt of its learner. */
    static SentinelAttempt.Change verified(long user){
        var b=sentinel.begin(user,SentinelPolicy.KING_CONQUEST,true,SentinelPolicy.POLICY_VERSION);String h=b.id()+"."+b.token();
        var a=sentinel.bind(user,h,SentinelPolicy.KING_CONQUEST,"ROOM");sentinel.playStarted(a,"M");sentinel.heartbeat(user,b.id(),b.token(),true);
        return sentinel.complete(a);
    }
    static KingConquestResults.Row row(long user,int size,String flow,int score,long at){
        return new KingConquestResults.Row(UUID.randomUUID(),user,size,flow,score,3,4,false,null,Instant.ofEpochSecond(1_800_000_000L+at),verified(user));
    }
    @SuppressWarnings("unchecked") static List<Map<String,Object>> top(Map<String,Object> b){return (List<Map<String,Object>>)b.get("top");}
    @Test void rankingsAreBestPerLearnerPerSizeAndCategory(){
        results.save(List.of(row(1,6,"SOLO",40,1),row(1,6,"SOLO",61,2),row(2,6,"SOLO",61,3),row(3,6,"SOLO",50,4),row(4,6,"SOLO",20,5),
            row(5,6,"SOLO",10,6),row(6,6,"SOLO",9,7),row(9,6,"SOLO",99,8),row(10,6,"SOLO",98,9),row(7,7,"SOLO",80,10),row(8,6,"QUICK_MATCH",70,11)));
        var match=UUID.randomUUID();var once=new KingConquestResults.Row(match,4,6,"SOLO",30,1,1,false,null,Instant.now(),verified(4));
        results.save(List.of(once,once));
        var b=results.board(3,6,"SOLO");var top=top(b);
        assertEquals(List.of(1L,2L,3L,4L,5L),top.stream().map(x->((Number)x.get("rank")).longValue()).toList());
        assertEquals(List.of(61,61,50,30,10),top.stream().map(x->x.get("score")).toList(),"best per learner; equal scores: earliest first");
        assertEquals("Học viên #1",top.getFirst().get("name"));assertTrue(top.stream().noneMatch(x->"Học viên #9".equals(x.get("name"))||"Học viên #10".equals(x.get("name"))));
        assertEquals(true,top.get(2).get("you"));
        @SuppressWarnings("unchecked") var you=(Map<String,Object>)b.get("you");assertEquals(50,you.get("best"));assertEquals(3,you.get("rank"));
        assertNull(results.board(11,6,"SOLO").get("you"),"no record: no invented score");
        @SuppressWarnings("unchecked") var admin=(Map<String,Object>)results.board(9,6,"SOLO").get("you");assertEquals(99,admin.get("best"));assertNull(admin.get("rank"),"the administrator sees their best but is never ranked");
        assertEquals(1,top(results.board(1,7,"SOLO")).size());assertEquals(70,top(results.board(1,6,"DUEL")).getFirst().get("score"));
        assertTrue(top(results.board(1,4,"SOLO")).isEmpty());
        assertEquals(1,sql.queryForObject("SELECT count(*) FROM public.king_conquest_results WHERE match_id=?",Integer.class,match),"one row per player per match");
        assertThrows(KingService.Rejection.class,()->results.board(1,8,"SOLO"));
        assertThrows(Exception.class,()->sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,finished_at) VALUES (gen_random_uuid(),1,6,'SOLO','SOLO',500,1,1,false,now())"));
    }
}
