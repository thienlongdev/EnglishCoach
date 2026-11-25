package com.englishcoach.spelling;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.spelling.SpellingProtocol.*;

/** Actual PostgreSQL constraints, Sentinel state, owner isolation and retry idempotency. */
class SpellingResultsPostgresTest {
    static PostgreSQLContainer<?> pg;static JdbcTemplate sql;static SpellingResults results;static SentinelService sentinel;
    @BeforeAll static void start()throws Exception{
        pg=new PostgreSQLContainer<>("postgres:17");pg.start();
        var ds=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());sql=new JdbcTemplate(ds);
        sql.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY,name text,role text DEFAULT 'ROLE_USER',account_status text DEFAULT 'ACTIVE');INSERT INTO public.users(id,name) SELECT g,'Learner '||g FROM generate_series(1,20) g;CREATE TABLE public.user_profiles(user_id BIGINT PRIMARY KEY,display_name text);");
        for(String file:List.of("V105__king_conquest_results.sql","V113__king_conquest_unlimited_score.sql","V119__echo_sentinel_attempts.sql","V127__echo_spelling_results.sql"))sql.execute(Files.readString(Path.of("src/main/resources/db/migration/exams",file)));
        results=new SpellingResults(sql,new ObjectMapper(),new DataSourceTransactionManager(ds));sentinel=new SentinelService(new SentinelStore(sql),Clock.systemUTC());
    }
    @AfterAll static void stop(){if(sentinel!=null)sentinel.close();if(pg!=null)pg.stop();}
    static SpellingResults.Seal seal(long user,String mode,String difficulty,int score,boolean verified){
        UUID match=UUID.randomUUID(),id=null;String integrity="PRACTICE";
        if(verified){var b=sentinel.begin(user,SentinelPolicy.ECHO_SPELLING,true,1);var a=sentinel.bind(user,b.id()+"."+b.token(),SentinelPolicy.ECHO_SPELLING,match.toString());sentinel.playStarted(a,match.toString());sentinel.heartbeat(user,b.id(),b.token(),true);sentinel.persist(sentinel.complete(a));id=a.id();integrity=a.state().name();}
        return new SpellingResults.Seal(user,new Run(match,mode,difficulty,score,3,1,2,60,75,15000,true,integrity,Instant.now().toString(),List.of()),id,verified);
    }
    @Test void ownerModeAndDifficultyAreIsolatedAndRetriesCannotMintRecords(){
        var first=seal(5,"ENDLESS","EASY",100,true);assertTrue(results.save(first).contains("SCORE"));assertTrue(results.save(first).isEmpty());
        results.save(seal(5,"ENDLESS","HARD",300,true));results.save(seal(5,"SPRINT","EASY",200,true));results.save(seal(6,"ENDLESS","EASY",999,true));
        var mine=results.records(5);assertEquals(3,mine.recent().size());assertEquals(3,mine.best().size());assertTrue(mine.recent().stream().noneMatch(x->x.score()==999));
        assertEquals(100,mine.best().stream().filter(x->x.mode().equals("ENDLESS")&&x.difficulty().equals("EASY")).findFirst().orElseThrow().highestScore());
        assertEquals(1,sql.queryForObject("select count(*) from public.spelling_results where match_id=?",Integer.class,first.run().matchId()));
    }
    @Test void practiceNeverBecomesCompetitiveRecord(){var row=seal(2,"PRACTICE","HARD",9999,false);results.save(row);
        var best=results.records(2).best().stream().filter(x->x.mode().equals("PRACTICE")).findFirst().orElseThrow();assertEquals(9999,best.highestScore());assertEquals(1,best.attempts());assertTrue(results.leaderboard("HARD").stream().noneMatch(x->((Number)x.get("user_id")).longValue()==2));}
    @Test void databaseRefusesUnverifiedOrCrossOwnerEligibleResults(){var fake=seal(2,"ENDLESS","MEDIUM",700,false);
        assertThrows(Exception.class,()->results.save(new SpellingResults.Seal(2,fake.run(),null,true)));
        var valid=seal(1,"MULTIPLAYER","MEDIUM",90,true);assertThrows(Exception.class,()->results.save(new SpellingResults.Seal(2,valid.run(),valid.sentinel(),true)));}
    @Test void acceptedRowsAreImmutableAndRankingsExcludeSolo(){var row=seal(1,"MULTIPLAYER","HARD",120,true);results.save(row);
        assertThrows(Exception.class,()->sql.update("update public.spelling_results set score=200 where match_id=?",row.run().matchId()));
        assertThrows(Exception.class,()->sql.update("delete from public.spelling_results where match_id=?",row.run().matchId()));
        assertTrue(results.leaderboard("HARD").stream().anyMatch(x->((Number)x.get("user_id")).longValue()==1));
        assertTrue(results.leaderboard("EASY").isEmpty());}
}
