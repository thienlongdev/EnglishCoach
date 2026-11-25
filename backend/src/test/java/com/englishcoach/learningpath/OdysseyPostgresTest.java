package com.englishcoach.learningpath;

import com.englishcoach.grammar.*;
import com.englishcoach.learningpath.OdysseyDtos.*;
import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Real V94/V96/V108/V112 on disposable PostgreSQL17, runtime DML role. No production access. */
class OdysseyPostgresTest {
    static PostgreSQLContainer<?> pg; static JdbcTemplate sql; static OdysseyRepository repo; static OdysseyService service;
    static GrammarContent content; static GrammarRepository grammar; static GrammarService academy; static TransactionTemplate tx;
    static LearningPathService path; static LearningPathRepository plans; static long next=10;
    static final ObjectMapper MAPPER=new ObjectMapper().registerModule(new JavaTimeModule());
    @BeforeAll static void start() throws Exception {
        pg=new PostgreSQLContainer<>("postgres:17");pg.start();
        var admin=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());sql=new JdbcTemplate(admin);
        sql.execute("CREATE SCHEMA exams; CREATE TABLE public.users(id bigint PRIMARY KEY,name text); INSERT INTO public.users SELECT g,'QA' FROM generate_series(1,500) g;");
        sql.execute("CREATE TABLE public.premium_feature_definitions(feature_key varchar(64) PRIMARY KEY,display_name text,description text,premium_required boolean,free_trial_limit int,premium_monthly_limit int,enabled boolean,sort_order int);");
        sql.execute("CREATE TABLE public.skill_proficiency(user_id bigint,skill text,status text,rating int);");
        for(String name:List.of("V94__database_runtime_least_privilege.sql","V96__learning_path.sql","V108__grammar_academy.sql","V112__learning_path_odyssey.sql"))
            sql.execute(Files.readString(Path.of("src/main/resources/db/migration/exams",name)));
        sql.execute("ALTER TABLE public.learning_path_task ADD COLUMN target_ref varchar(100); ALTER ROLE english_coach_app PASSWORD 'odyssey-test-only'");
        var app=new DriverManagerDataSource(pg.getJdbcUrl(),"english_coach_app","odyssey-test-only");var named=new NamedParameterJdbcTemplate(app);
        repo=new OdysseyRepository(named);plans=new LearningPathRepository(named,MAPPER);content=new GrammarContent(MAPPER);grammar=new GrammarRepository(named,MAPPER);
        academy=new GrammarService(content,grammar,mock(LearningEventService.class),MAPPER);path=mock(LearningPathService.class);
        service=new OdysseyService(repo,new OdysseyCatalog(content),path,plans,content,grammar,academy);tx=new TransactionTemplate(new DataSourceTransactionManager(app));
    }
    @AfterAll static void stop(){if(pg!=null)pg.stop();}
    static synchronized long user(){return next++;}
    static List<Reward> reconcile(long u){return tx.execute(t->repo.reconcile(u));}
    static LaunchView launch(long u,String station,String mode){return tx.execute(t->service.launch(u,new LaunchRequest(UUID.randomUUID(),station,mode)));}
    static long task(long u,String status){return sql.queryForObject("""
        INSERT INTO public.learning_path_task(user_id,plan_day,position,plan_version,kind,skill,title,minutes,goal_count,reason_code,status,completed_at,evidence_ref)
        VALUES(?,current_date,1,1,'VOCAB_REVIEW','VOCABULARY','Review',5,1,'GOAL_CORE',?,CASE WHEN ?='DONE' THEN now() ELSE NULL END,CASE WHEN ?='DONE' THEN 'test:evidence' ELSE NULL END) RETURNING id
        """,Long.class,u,status,status,status);}
    @Test void discoveryIsIdempotentAndNeverGrantsAcademicCredit(){long u=user();
        tx.execute(t->service.discover(u,new ExploreRequest("reef",false)));tx.execute(t->service.discover(u,new ExploreRequest("reef",true)));
        Instant beacon=repo.exploration(u).getFirst().beaconAt();tx.execute(t->service.discover(u,new ExploreRequest("reef",true)));
        assertThat(repo.exploration(u)).hasSize(1);assertThat(repo.exploration(u).getFirst().beaconAt()).isEqualTo(beacon);
        assertThat(repo.rewards(u)).isZero();assertThat(grammar.states(u)).isEmpty();assertThat(repo.exploration(user())).isEmpty();
    }
    @Test void unknownRegionsFailClosed(){assertThatThrownBy(()->tx.execute(t->service.discover(user(),new ExploreRequest("not-a-region",true)))).isInstanceOf(LearningPathException.class);}
    @Test void navigationRestoresExactStation(){long u=user();var n=tx.execute(t->service.navigate(u,new NavigateRequest("harbor","grammar:what-is-a-sentence","REGION")));
        assertThat(repo.navigation(u)).isEqualTo(n);assertThat(repo.navigation(user()).stationId()).isNull();
    }
    @Test void navigationRejectsForeignTaskAndFalseRegion(){long u=user(),other=user(),id=task(other,"OPEN");
        assertThatThrownBy(()->tx.execute(t->service.navigate(u,new NavigateRequest("harbor","task:"+id,"REGION")))).isInstanceOf(LearningPathException.class);
        assertThatThrownBy(()->tx.execute(t->service.navigate(u,new NavigateRequest("reef","grammar:what-is-a-sentence","REGION")))).isInstanceOf(LearningPathException.class);
    }
    @Test void launchReceiptReplaysOneCheckEvenWithConcurrentTabs() throws Exception {long u=user();UUID id=UUID.randomUUID();var req=new LaunchRequest(id,"grammar:what-is-a-sentence","CHECK");
        try(var pool=Executors.newFixedThreadPool(2)){
            var a=pool.submit(()->tx.execute(t->service.launch(u,req)));var b=pool.submit(()->tx.execute(t->service.launch(u,req)));
            assertThat(a.get(30,TimeUnit.SECONDS).launch().checkId()).isEqualTo(b.get(30,TimeUnit.SECONDS).launch().checkId());
        }
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_check_session WHERE user_id=?",Integer.class,u)).isEqualTo(1);
        assertThatThrownBy(()->tx.execute(t->service.launch(u,new LaunchRequest(id,"grammar:verb-be","CHECK")))).isInstanceOf(LearningPathException.class);
    }
    @Test void launchAndSavedReceiptAreStrictlyOwnerScoped(){long u=user();var v=launch(u,"grammar:verb-be","LEARN");
        assertThat(service.launchById(u,v.launch().requestId()).href()).isEqualTo("/grammar/topics/verb-be");
        assertThatThrownBy(()->service.launchById(user(),v.launch().requestId())).isInstanceOf(LearningPathException.class);
    }
    @Test void unfinishedQuestNeverRewards(){long u=user();long id=task(u,"OPEN");launch(u,"task:"+id,"LEARN");
        assertThat(reconcile(u)).isEmpty();assertThat(repo.rewards(u)).isZero();
    }
    @Test void trueTaskCompletionRewardsOnceAcrossRepeatedLaunchAndReconciliation(){long u=user();long id=task(u,"OPEN");launch(u,"task:"+id,"LEARN");
        sql.update("UPDATE public.learning_path_task SET status='DONE',completed_at=now(),evidence_ref='real-row' WHERE id=?",id);
        assertThat(reconcile(u)).hasSize(1);launch(u,"task:"+id,"LEARN");
        assertThat(reconcile(u)).isEmpty();assertThat(repo.rewards(u)).isEqualTo(1);assertThat(repo.rewards(user())).isZero();
    }
    @Test void concurrentRewardReconciliationCannotDuplicate()throws Exception{long u=user();long id=task(u,"DONE");launch(u,"task:"+id,"LEARN");
        try(var pool=Executors.newFixedThreadPool(2)){var a=pool.submit(()->reconcile(u));var b=pool.submit(()->reconcile(u));assertThat(a.get().size()+b.get().size()).isEqualTo(1);}
    }
    @Test void openedAndStudiedGrammarDoNotGrantCheckReward(){long u=user();launch(u,"grammar:verb-be","LEARN");
        tx.execute(t->{academy.open(u,"verb-be");academy.studied(u,"verb-be");return null;});
        assertThat(reconcile(u)).isEmpty();assertThat(grammar.state(u,"verb-be").orElseThrow().masteredAt()).isNull();
    }
    @Test void actualFailedCheckKeepsAdvancedBranchClosedAndOffersRemediation(){long u=user();var v=launch(u,"grammar:present-perfect-basics","CHECK");
        var result=tx.execute(t->academy.submit(u,v.launch().checkId(),new GrammarDtos.CheckSubmit(Map.of())));
        assertThat(result.mastery()).isEqualTo("NOT_YET");assertThat(result.pct()).isZero();assertThat(reconcile(u)).isEmpty();
        var station=service.region(u,"tides").stations().stream().filter(s->s.id().equals("grammar:present-perfect-basics")).findFirst().orElseThrow();
        assertThat(station.gate().remediation()).isEqualTo("PRACTICE_OR_CHALLENGE");assertThat(station.status()).isEqualTo("REMEDIATION");
        if(!station.prerequisites().isEmpty())assertThatThrownBy(()->launch(u,station.id(),"ADVANCE")).isInstanceOf(LearningPathException.class);
    }
    @Test void serverCheckResultIsRequiredForRewardAndOneTopicHasOneCosmeticReceipt(){long u=user();var v=launch(u,"grammar:verb-be","CHECK");
        sql.update("UPDATE public.grammar_check_session SET submitted_at=now(),pct=90,scored_items=6,result='{\"enoughEvidence\":false,\"mastery\":\"MASTERED\"}'::jsonb WHERE id=?",v.launch().checkId());
        assertThat(reconcile(u)).isEmpty();
        sql.update("UPDATE public.grammar_check_session SET result='{\"enoughEvidence\":true,\"mastery\":\"MASTERED\"}'::jsonb WHERE id=?",v.launch().checkId());
        assertThat(reconcile(u)).hasSize(1);var again=launch(u,"grammar:verb-be","CHECK");
        sql.update("UPDATE public.grammar_check_session SET submitted_at=now(),result='{\"enoughEvidence\":true,\"mastery\":\"MASTERED\"}'::jsonb WHERE id=?",again.launch().checkId());
        assertThat(reconcile(u)).isEmpty();assertThat(repo.rewards(u)).isEqualTo(1);
    }
    @Test void currentEvidenceRejectsOldContentAndExpiredRetention(){var meta=content.meta("verb-be").orElseThrow();Instant now=Instant.now();
        var state=new GrammarRepository.State(meta.slug(),now,now,now,10,10,100,100,now,now,0,now.plusSeconds(3600),false);
        assertThat(OdysseyService.current(meta,state,new OdysseyRepository.TopicCheck(meta.slug(),true,now,meta.version()),now)).isTrue();
        assertThat(OdysseyService.current(meta,state,new OdysseyRepository.TopicCheck(meta.slug(),true,now,meta.version()-1),now)).isFalse();
        assertThat(OdysseyService.current(meta,state,new OdysseyRepository.TopicCheck(meta.slug(),false,now,meta.version()),now)).isFalse();
        assertThat(OdysseyService.current(meta,state,new OdysseyRepository.TopicCheck(meta.slug(),true,now,meta.version()),now.plusSeconds(4000))).isFalse();
    }
    @Test void genuinePassedCheckUnlocksOnlyItsConceptThenFailedRetakeRequiresRemediation(){
        long u=user();var first=launch(u,"grammar:present-perfect-basics","CHECK");
        Map<String,com.fasterxml.jackson.databind.JsonNode> answers=new LinkedHashMap<>();
        for(var item:grammar.session(first.launch().checkId(),u,false).orElseThrow().items())answers.put(item.exercise().path("id").asText(),correct(item.exercise()));
        var result=tx.execute(t->academy.submit(u,first.launch().checkId(),new GrammarDtos.CheckSubmit(answers)));
        assertThat(result.mastery()).isEqualTo("MASTERED");assertThat(reconcile(u)).hasSize(1);
        var own=service.region(u,"tides").stations().stream().filter(s->s.id().equals("grammar:present-perfect-basics")).findFirst().orElseThrow();
        assertThat(own.gate().state()).isEqualTo("READY");assertThat(launch(u,own.id(),"ADVANCE").href()).endsWith("?layer=deep");
        assertThat(repo.skillEvidence(u)).isEmpty(); // Grammar success never certifies Listening/Speaking/IELTS.
        var second=launch(u,own.id(),"CHECK");tx.execute(t->academy.submit(u,second.launch().checkId(),new GrammarDtos.CheckSubmit(Map.of())));
        assertThat(grammar.state(u,"present-perfect-basics").orElseThrow().masteredAt()).isNotNull();
        var failed=service.region(u,"tides").stations().stream().filter(s->s.id().equals(own.id())).findFirst().orElseThrow();
        assertThat(failed.gate().state()).isEqualTo("PREREQUISITES");assertThat(reconcile(u)).isEmpty();
    }
    private static com.fasterxml.jackson.databind.node.ObjectNode correct(com.fasterxml.jackson.databind.JsonNode ex){
        var a=MAPPER.createObjectNode();switch(ex.path("type").asText()){
            case "choice"->{for(int i=0;i<ex.path("options").size();i++)if(ex.path("options").get(i).path("ok").asBoolean()){a.put("choice",i);break;}}
            case "multi"->{var v=a.putArray("choices");for(int i=0;i<ex.path("options").size();i++)if(ex.path("options").get(i).path("ok").asBoolean())v.add(i);}
            case "cloze"->{var b=a.putObject("blanks");ex.path("blanks").fields().forEachRemaining(e->b.put(e.getKey(),e.getValue().path("accept").get(0).asText()));}
            case "order"->a.set("seq",ex.path("accept").get(0));case "transform"->a.put("text",ex.path("accept").get(0).asText());
            case "error"->{var p=a.putArray("picked");for(int i=0;i<ex.path("segments").size();i++)if(ex.path("segments").get(i).path("bad").asBoolean())p.add(i);if(p.isEmpty()){a.remove("picked");a.put("none",true);}}
            case "match"->{var p=a.putObject("pairs");for(int i=0;i<ex.path("pairs").size();i++)p.put(String.valueOf(i),ex.path("pairs").get(i).path("b").asText());}
            case "classify"->{var p=a.putObject("cats");for(int i=0;i<ex.path("items").size();i++)p.put(String.valueOf(i),ex.path("items").get(i).path("cat").asText());}
            default->throw new AssertionError("Unexpected held-out type "+ex.path("type"));
        }return a;
    }
    @Test void preferencesKeepLearningHistoryAndRejectPastDate(){long u=user();long id=task(u,"DONE");
        tx.execute(t->service.preferences(u,new PreferencesRequest(LocalDate.now().plusMonths(8),210,"ACADEMIC")));
        assertThat(repo.navigation(u).weeklyMinutes()).isEqualTo(210);assertThat(repo.task(u,id).orElseThrow().status()).isEqualTo("DONE");
        assertThatThrownBy(()->tx.execute(t->service.preferences(u,new PreferencesRequest(LocalDate.now().minusDays(1),210,"ACADEMIC")))).isInstanceOf(LearningPathException.class);
    }
    @Test void allGrammarTopicsHaveARealRegionAndNoUnsupportedTargets(){var catalog=new OdysseyCatalog(content);
        assertThat(content.topics()).hasSize(221);for(var t:content.topics()){assertThat(t.available()).isTrue();assertThat(catalog.region(catalog.grammarRegion(t.slug()))).isNotNull();}
        assertThat(OdysseyCatalog.REGIONS.stream().map(OdysseyCatalog.Region::id).distinct().count()).isEqualTo(15);
        for(var r:OdysseyCatalog.REGIONS)for(var n:r.neighbors())assertThat(catalog.region(n)).isNotNull();
    }
    @Test void oneSkillsEvidenceCannotUnlockAnotherSkill(){long u=user();sql.update("INSERT INTO public.skill_proficiency VALUES(?,'READING','VERIFIED',600),(?,'SPEAKING','UNDETERMINED',0)",u,u);
        var evidence=repo.skillEvidence(u);assertThat(evidence.stream().filter(e->e.skill().equals("READING")).findFirst().orElseThrow().currentVerified()).isTrue();
        assertThat(evidence.stream().filter(e->e.skill().equals("SPEAKING")).findFirst().orElseThrow().currentVerified()).isFalse();
    }
    @Test void runtimeCannotCreateTables(){assertThatThrownBy(()->tx.execute(t->{new NamedParameterJdbcTemplate(new DriverManagerDataSource(pg.getJdbcUrl(),"english_coach_app","odyssey-test-only")).getJdbcTemplate().execute("CREATE TABLE public.odyssey_forbidden(x int)");return null;})).isInstanceOf(Exception.class);}
    @Test void noUrlCanEscapeTheKnownModuleRoutes(){var t=new LearningPathDtos.TaskView(1,"EXAM_PRACTICE","READING",null,"IELTS","",20,1,0,"OPEN","GOAL_CORE",false,null,"https://attacker.invalid");
        assertThatThrownBy(()->OdysseyService.taskHref(t)).isInstanceOf(LearningPathException.class);assertThat(LearningPathService.normaliseTarget("TOEIC","990")).isEqualTo("990");
    }
    @Test void advancedLearnerGetsRelevantGrammarWithoutFalseBeginnerAssumption(){
        long u=user();List<Station> all=new ArrayList<>();for(var region:OdysseyCatalog.REGIONS)all.addAll(service.region(u,region.id()).stations().stream().filter(s->s.kind().equals("GRAMMAR")).toList());
        var advanced=new LearningPathDtos.PlanView("IELTS",30,"7.5","B2","PLACEMENT",1,1,Map.of(),null);
        var next=OdysseyService.recommendGrammar(all,advanced);assertThat(next).isNotEmpty();assertThat(next).allMatch(s->s.level().equals("B2"));
        var beginner=new LearningPathDtos.PlanView("IELTS",30,"7.5","A2","PROVISIONAL",1,1,Map.of(),null);
        assertThat(OdysseyService.recommendGrammar(all,beginner)).allMatch(s->Set.of("preA1","A1").contains(s.level()));
        assertThat(OdysseyService.recommendGrammar(all,new LearningPathDtos.PlanView("TOEIC",30,"990","B2","PLACEMENT",1,1,Map.of(),null)))
            .extracting(Station::id).containsExactlyElementsOf(next.stream().map(Station::id).toList());
    }
    /** Regression 2026-11-14: a known level never recommends a topic before its own same-level prerequisite. A learner
        is walked through the real catalog (each step passes the first suggestion); at every step no suggestion may lack
        a prerequisite at the learner's level or above, and every suggestion stays at that level. */
    @Test void knownLevelNeverRecommendsATopicBeforeItsSameLevelPrerequisite(){
        long u=user();List<Station> base=new ArrayList<>();Set<String> seen=new HashSet<>();
        for(var region:OdysseyCatalog.REGIONS)for(var s:service.region(u,region.id()).stations())if(s.kind().equals("GRAMMAR")&&seen.add(s.id()))base.add(s);
        Map<String,String> levelOf=new HashMap<>();for(var s:base)levelOf.put(s.id().substring(8),s.level());
        List<String> order=List.of("preA1","A1","A2","B1","B2","C1","C2");
        for(String lv:List.of("A2","B1","B2","C1")){
            var plan=new LearningPathDtos.PlanView("GENERAL",30,null,lv,"PLACEMENT",1,1,Map.of(),null);
            Set<String> passedSlugs=new HashSet<>();int steps=0;
            while(steps++<40){
                List<Station> now=base.stream().map(s->{String slug=s.id().substring(8);boolean done=passedSlugs.contains(slug);
                    List<String> missing=done?List.of():s.prerequisites().stream().filter(p->!passedSlugs.contains(p)).toList();
                    return new Station(s.id(),s.regionId(),s.title(),s.kind(),s.skill(),s.level(),s.domain(),done?"CHECK_PASSED":"NOT_STARTED",
                        new Gate(done||missing.isEmpty()?"READY":"PREREQUISITES",s.prerequisites(),missing,s.gate().evidenceBasis(),s.gate().remediation()),
                        s.checkAvailable(),s.learningRole(),s.prerequisites(),s.task(),s.reviewedAt());}).toList();
                var next=OdysseyService.recommendGrammar(now,plan);
                if(next.isEmpty())break;
                for(var r:next){
                    assertThat(r.level()).as("%s at %s",r.id(),lv).isEqualTo(lv);
                    assertThat(r.gate().missing()).as("%s waits for its same-level prerequisite (%s)",r.id(),lv)
                        .allMatch(m->order.indexOf(levelOf.getOrDefault(m,"C2"))<order.indexOf(lv));
                }
                passedSlugs.add(next.getFirst().id().substring(8));
            }
            assertThat(steps).as("progress at %s",lv).isGreaterThan(3);
        }
        // The B2 case that used to jump: with complex-noun-phrases passed, articles-in-context waits for generic-reference.
        var plan=new LearningPathDtos.PlanView("GENERAL",30,null,"B2","PLACEMENT",1,1,Map.of(),null);
        List<Station> now=base.stream().map(s->{boolean done=s.id().equals("grammar:complex-noun-phrases");
            List<String> missing=done?List.of():s.prerequisites().stream().filter(p->!p.equals("complex-noun-phrases")).toList();
            return new Station(s.id(),s.regionId(),s.title(),s.kind(),s.skill(),s.level(),s.domain(),done?"CHECK_PASSED":"NOT_STARTED",
                new Gate(missing.isEmpty()?"READY":"PREREQUISITES",s.prerequisites(),missing,s.gate().evidenceBasis(),s.gate().remediation()),s.checkAvailable(),s.learningRole(),s.prerequisites(),s.task(),s.reviewedAt());}).toList();
        assertThat(OdysseyService.recommendGrammar(now,plan)).extracting(Station::id).doesNotContain("grammar:articles-in-context").contains("grammar:generic-reference");
    }
}
