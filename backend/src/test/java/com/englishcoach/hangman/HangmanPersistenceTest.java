package com.englishcoach.hangman;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.testcontainers.containers.PostgreSQLContainer;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import static com.englishcoach.hangman.HangmanRules.*;
import static org.junit.jupiter.api.Assertions.*;

/** Real PG17, existing immutable V76 and real transaction/receipt/owner queries.
 * Disposable local users only; no live application or production credentials. */
class HangmanPersistenceTest {
    static PostgreSQLContainer<?> pg;
    static HikariDataSource ds;
    static JdbcTemplate jdbc;
    static HangmanRepository repo;
    static HangmanService service;
    static HangmanCatalog catalog;
    static com.englishcoach.kingofenglish.KingCorpus corpus;
    static final AtomicLong USERS=new AtomicLong(100);

    @BeforeAll static void setup() {
        pg=new PostgreSQLContainer<>("postgres:17"); pg.start();
        var config=new HikariConfig(); config.setJdbcUrl(pg.getJdbcUrl()); config.setUsername(pg.getUsername());
        config.setPassword(pg.getPassword()); config.setMaximumPoolSize(8); ds=new HikariDataSource(config);
        jdbc=new JdbcTemplate(ds);
        jdbc.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY); CREATE SCHEMA exams; CREATE TABLE exams.test_baseline(id INT)");
        var flyway=Flyway.configure().dataSource(ds).schemas("exams").defaultSchema("exams")
                .locations("classpath:db/migration/exams").baselineOnMigrate(true).baselineVersion("75").target("76").load();
        assertEquals(1,flyway.migrate().migrationsExecuted);
        assertEquals(0,flyway.migrate().migrationsExecuted);
        repo=new HangmanRepository(jdbc); corpus=new com.englishcoach.kingofenglish.KingCorpus("REVIEW_PREVIEW"); catalog=new HangmanCatalog(new ObjectMapper(),corpus);
        service=new HangmanService(repo,catalog,new DataSourceTransactionManager(ds));
    }
    @AfterAll static void stop() { if(corpus!=null)corpus.close(); if(ds!=null) ds.close(); if(pg!=null) pg.stop(); }
    static long user() { long id=USERS.incrementAndGet(); jdbc.update("INSERT INTO public.users(id) VALUES(?)",id); return id; }
    static UUID key() { return UUID.randomUUID(); }
    static HangmanDtos.Round start(long user,Difficulty d,int level) { return service.start(user,new HangmanDtos.StartRequest(d,level,key())); }
    static String answer(long user,HangmanDtos.Round round) { return repo.owned(user,round.roundId()).state().answer(); }
    static HangmanDtos.Round finish(long user,HangmanDtos.Round round,boolean win) {
        String answer=answer(user,round);
        for(char letter='A';letter<='Z'&&round.status()==Status.ACTIVE;letter++) {
            if((answer.indexOf(letter)>=0)==win) round=service.guess(user,round.roundId(),new HangmanDtos.GuessRequest(String.valueOf(letter),key(),round.version()));
        }
        assertEquals(win?Status.WON:Status.LOST,round.status()); return round;
    }
    static int rounds(long user,Difficulty d) { return jdbc.queryForObject("SELECT count(*) FROM public.hangman_rounds WHERE user_id=? AND difficulty=?",Integer.class,user,d.name()); }

    @Test void lossRetryHasFreshSnapshotWithoutUnlockAndKeepsHistory() {
        long u=user(); var lost=finish(u,start(u,Difficulty.EASY,1),false);
        var retry=service.retry(u,lost.roundId(),new HangmanDtos.RetryRequest(key()));
        assertNotEquals(lost.answer(),answer(u,retry)); assertEquals(1,retry.levelNumber());
        assertEquals(8,retry.remainingBalloons()); assertEquals(2,retry.hintsRemaining());
        assertTrue(retry.correctLetters().isEmpty()); assertTrue(retry.wrongLetters().isEmpty()); assertTrue(retry.hintedLetters().isEmpty());
        assertNull(retry.answer()); assertNull(retry.score());
        assertEquals(1,repo.progress(u,Difficulty.EASY).highest()); assertFalse(repo.progress(u,Difficulty.EASY).completed());
        assertEquals(lost,service.get(u,lost.roundId())); assertEquals(2,rounds(u,Difficulty.EASY));
    }

    @Test void winNextAndWinReplayUseFreshWordsWithMonotoneProgress() {
        long u=user(); var won=finish(u,start(u,Difficulty.MEDIUM,1),true);
        assertTrue(won.nextLevelAvailable()); assertEquals(2,repo.progress(u,Difficulty.MEDIUM).highest());
        var replay=service.retry(u,won.roundId(),new HangmanDtos.RetryRequest(key()));
        assertEquals(1,replay.levelNumber()); assertNotEquals(won.answer(),answer(u,replay));
        var again=finish(u,replay,true); assertEquals(2,repo.progress(u,Difficulty.MEDIUM).highest());
        var next=start(u,Difficulty.MEDIUM,2); assertEquals(2,next.levelNumber()); assertNotEquals(again.answer(),answer(u,next));
        assertEquals(won.score(),service.get(u,won.roundId()).score());
    }

    @Test void refreshAndStartResumeTheSameAnswerLettersHintsAndVersion() {
        long u=user(); var r=start(u,Difficulty.HARD,1); String original=answer(u,r);
        String wrong="ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars().filter(c->original.indexOf(c)<0).mapToObj(c->String.valueOf((char)c)).findFirst().orElseThrow();
        r=service.guess(u,r.roundId(),new HangmanDtos.GuessRequest(wrong,key(),r.version()));
        r=service.hint(u,r.roundId(),new HangmanDtos.HintRequest(key(),r.version()));
        assertEquals(r,service.get(u,r.roundId())); assertEquals(r,start(u,Difficulty.HARD,1));
        assertEquals(original,answer(u,r)); assertEquals(5,r.remainingBalloons()); assertEquals(1,r.hintsRemaining()); assertEquals(1,rounds(u,Difficulty.HARD));
    }

    @Test void duplicateRetryAndSeparateConcurrentRetryIdsCreateOnlyOneRound() throws Exception {
        long u=user(); var lost=finish(u,start(u,Difficulty.EASY,1),false); UUID request=key();
        var first=service.retry(u,lost.roundId(),new HangmanDtos.RetryRequest(request));
        assertEquals(first,service.retry(u,lost.roundId(),new HangmanDtos.RetryRequest(request)));
        assertEquals(first,service.retry(u,lost.roundId(),new HangmanDtos.RetryRequest(key())));
        var lostAgain=finish(u,first,false);
        var gate=new CountDownLatch(1);
        try(var executor=Executors.newFixedThreadPool(2)) {
            Callable<HangmanDtos.Round> command=()->{gate.await();return service.retry(u,lostAgain.roundId(),new HangmanDtos.RetryRequest(key()));};
            var a=executor.submit(command); var b=executor.submit(command); gate.countDown();
            assertEquals(a.get(15,TimeUnit.SECONDS).roundId(),b.get(15,TimeUnit.SECONDS).roundId());
        }
        assertEquals(3,rounds(u,Difficulty.EASY)); assertEquals(1,repo.progress(u,Difficulty.EASY).highest());
    }

    @Test void concurrentVersionedGuessesCommitExactlyOnce() throws Exception {
        long u=user(); var r=start(u,Difficulty.HARD,1); String word=answer(u,r);
        var letters="ABCDEFGHIJKLMNOPQRSTUVWXYZ".chars().filter(c->word.indexOf(c)<0).limit(2).mapToObj(c->String.valueOf((char)c)).toList();
        var gate=new CountDownLatch(1);
        try(var executor=Executors.newFixedThreadPool(2)) {
            var tasks=new ArrayList<Future<String>>();
            for(String letter:letters) tasks.add(executor.submit(()->{gate.await();try {service.guess(u,r.roundId(),new HangmanDtos.GuessRequest(letter,key(),0));return "COMMITTED";}catch(HangmanException error){return error.code;}}));
            gate.countDown(); var outcomes=new ArrayList<String>(); for(var task:tasks) outcomes.add(task.get(15,TimeUnit.SECONDS));
            assertEquals(1,Collections.frequency(outcomes,"COMMITTED")); assertEquals(1,Collections.frequency(outcomes,"ROUND_CHANGED"));
        }
        assertEquals(1,service.get(u,r.roundId()).version()); assertEquals(5,service.get(u,r.roundId()).remainingBalloons());
    }

    @Test void ownerAndDifficultyAreIndependentAndActiveAnswersStayHidden() {
        long a=user(),b=user(); var easy=finish(a,start(a,Difficulty.EASY,1),true); var hard=start(a,Difficulty.HARD,1); var other=start(b,Difficulty.EASY,1);
        assertEquals(2,repo.progress(a,Difficulty.EASY).highest()); assertEquals(1,repo.progress(a,Difficulty.HARD).highest()); assertEquals(1,repo.progress(b,Difficulty.EASY).highest());
        assertNull(hard.answer()); assertNull(other.answer()); assertNotEquals(easy.roundId(),other.roundId());
        assertEquals("ROUND_NOT_FOUND",assertThrows(HangmanException.class,()->service.get(b,hard.roundId())).code);
        assertEquals("ROUND_NOT_FOUND",assertThrows(HangmanException.class,()->service.retry(b,easy.roundId(),new HangmanDtos.RetryRequest(key()))).code);
        assertEquals("LEVEL_LOCKED",assertThrows(HangmanException.class,()->start(b,Difficulty.EASY,2)).code);
    }

    @Test void staleTerminalRetryCannotReturnANewerTerminalRound() {
        long u=user(); var old=finish(u,start(u,Difficulty.HARD,1),false);
        var next=service.retry(u,old.roundId(),new HangmanDtos.RetryRequest(key())); next=finish(u,next,false);
        assertEquals("ROUND_CHANGED",assertThrows(HangmanException.class,()->service.retry(u,old.roundId(),new HangmanDtos.RetryRequest(key()))).code);
        assertEquals(2,rounds(u,Difficulty.HARD)); assertEquals(next.roundId(),repo.progress(u,Difficulty.HARD).current());
    }

    @Test void lastLevelCompletionAndReplaysDoNotEraseProgressOrAddRewards() {
        long u=user(); start(u,Difficulty.EASY,1);
        // Local fixture gate only; production progression is exercised through guesses.
        jdbc.update("UPDATE public.hangman_progress SET highest_unlocked=20 WHERE user_id=? AND difficulty='EASY'",u);
        var first=finish(u,service.get(u,repo.progress(u,Difficulty.EASY).current()),true);
        var finalRound=finish(u,start(u,Difficulty.EASY,20),true);
        assertTrue(finalRound.catalogCompleted()); assertFalse(finalRound.nextLevelAvailable());
        var retry=service.retry(u,finalRound.roundId(),new HangmanDtos.RetryRequest(key()));
        assertTrue(retry.catalogCompleted()); assertNotEquals(finalRound.answer(),answer(u,retry));
        assertEquals(20,repo.progress(u,Difficulty.EASY).highest()); assertEquals(first.score(),service.get(u,first.roundId()).score());
    }

    @Test void recentTerminalWordsAreAvoidedAndSnapshotsReferenceApprovedPool() {
        long u=user(); var seen=new HashSet<String>();
        for(int i=0;i<13;i++) {
            var round=start(u,Difficulty.MEDIUM,1); String word=answer(u,round); assertTrue(seen.add(word));
            assertTrue(catalog.pool(Difficulty.MEDIUM).stream().anyMatch(level->level.answer().equals(word)));
            assertEquals(catalog.version(),repo.owned(u,round.roundId()).answerVersion()); finish(u,round,false);
        }
    }
    @Test void persistedLegacyActiveRoundsRetainBudgetAndRetryUsesNewRules(){
        for(var d:Difficulty.values()){
            long u=user();repo.lockTrack(u,d);var seed=catalog.level(d,1);
            var old=HangmanRules.start(seed.answer(),d,new Random(1));
            old=new State(old.answer(),d,old.prefilled(),"","",d.balloons+2,Status.ACTIVE,0);
            var stored=repo.insert(u,seed,old);var resumed=start(u,d,1);
            assertEquals(stored.id(),resumed.roundId());assertEquals(d.balloons+2,resumed.initialBalloons());
            var lost=finish(u,resumed,false);assertEquals(d.balloons+2,lost.initialBalloons());
            var next=service.retry(u,lost.roundId(),new HangmanDtos.RetryRequest(key()));
            assertEquals(d.balloons,next.initialBalloons());assertEquals(d.balloons,next.remainingBalloons());
            assertEquals(lost,service.get(u,lost.roundId()));
        }
    }
    @Test void durableEncounterHistoryIsNotLimitedToRecentWindow(){
        long u=user();var seen=new HashSet<String>();
        for(int i=0;i<40;i++){var r=start(u,Difficulty.HARD,1);assertTrue(seen.add(answer(u,r)));finish(u,r,false);}
        assertEquals(40,repo.encounters(u).size());
        assertTrue(repo.encounters(user()).isEmpty());
        var easy=finish(u,start(u,Difficulty.EASY,1),false);assertEquals(41,repo.encounters(u).size());
        assertTrue(repo.encounters(u).stream().anyMatch(e->e.answer().equals(easy.answer())));
    }
}
