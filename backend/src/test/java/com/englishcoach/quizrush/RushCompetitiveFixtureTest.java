package com.englishcoach.quizrush;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.*;
import com.englishcoach.kingofenglish.KingCorpus;
import com.englishcoach.flashcard.pvp.config.WebSocketConfig;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.annotation.*;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.web.bind.annotation.*;
import org.testcontainers.containers.PostgreSQLContainer;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import java.time.*;
import java.util.*;
import java.nio.file.*;
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;

/** Explicit localhost-only fixture. Synthetic auth; real production broker/interceptors and PostgreSQL. */
@EnabledIfSystemProperty(named="quizrush.competitive.browser",matches="true")
class RushCompetitiveFixtureTest {
    @Configuration
    @EnableAutoConfiguration(exclude={org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({RushController.class,RushService.class,RushRepository.class,RushQuestions.class,RushExceptionHandler.class,KingCorpus.class,RushExposureStore.class,
        RushCompetitiveController.class,RushCompetitiveService.class,RushCompetitiveRepository.class,RushCompetitiveChannelGuard.class,
        WebSocketConfig.class,StompAuthChannelInterceptor.class,Truth.class})
    static class Fixture {
        @Bean CardBlastPvPService cardBlast(){return mock(CardBlastPvPService.class);}
        /** Non-production properties: since security V3 the socket handshake authenticates from the dev session cookie. */
        @Bean AuthSecurityProperties authSecurityProperties(org.springframework.core.env.Environment environment){return new AuthSecurityProperties(environment);}
        @Bean LoginThrottleService throttle(){var t=mock(LoginThrottleService.class);when(t.checkAndIncrementRateLimit(anyString(),anyString(),anyInt(),anyInt())).thenReturn(true);return t;}
        @Bean JwtDecoder decoder(){return token->{if(!token.matches("rush-fixture-user[1-6]"))throw new JwtException("Local fixture only");return new Jwt(token,Instant.now(),Instant.now().plusSeconds(3600),Map.of("alg","fixture-only"),Map.of("sub",token.substring(token.length()-1)));};}
        @Bean CustomJwtAuthenticationConverter converter(){var c=mock(CustomJwtAuthenticationConverter.class);when(c.convert(any(Jwt.class))).thenAnswer(inv->{Jwt jwt=inv.getArgument(0);long id=Long.parseLong(jwt.getSubject());var u=new UserDetailsImpl(id,"fixture"+id+"@example.test","",List.of());return new UsernamePasswordAuthenticationToken(u,null,u.getAuthorities());});return c;}
        @Bean SecurityFilterChain security(HttpSecurity http,CustomJwtAuthenticationConverter c)throws Exception {return http.csrf(x->x.disable()).authorizeHttpRequests(x->x.requestMatchers("/ws-card-blast","/ws").permitAll().anyRequest().authenticated()).oauth2ResourceServer(x->x.jwt(j->j.jwtAuthenticationConverter(c))).build();}
    }
    @RestController static class Truth {
        private final RushCompetitiveRepository repo;private final RushCompetitiveService service;private final KingCorpus corpus;private final RushQuestions questions;private final RushRepository solo;
        Truth(RushCompetitiveRepository repo,RushCompetitiveService service,KingCorpus corpus,RushQuestions questions,RushRepository solo){this.repo=repo;this.service=service;this.corpus=corpus;this.questions=questions;this.solo=solo;}
        /** Test-only Solo oracle for automated journeys: the current answer id of the caller's own race. */
        @GetMapping("/fixture/solo-truth/{id}") Map<String,Object> soloTruth(@org.springframework.security.core.annotation.AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){
            var race=solo.get(user.getId(),id);if(race.checkpoint>=race.questions.size())return Map.of("done",true);var q=race.questions.get(race.checkpoint);
            return Map.of("checkpoint",race.checkpoint,"answerId",q.answerId(),"boundaries",race.boundaries,"courseVersion",race.courseVersion);
        }
        @GetMapping("/fixture/competitive/truth/{id}") Map<String,Object> truth(@org.springframework.security.core.annotation.AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){
            var state=service.get(user.getId(),id);var room=repo.get(user.getId(),id);String you=(String)state.get("you");var racer=room.race.racers.stream().filter(p->p.id.equals(you)).findFirst().orElseThrow();
            var player=((List<Map<String,Object>>)state.get("players")).stream().filter(p->p.get("id").equals(you)).findFirst().orElseThrow();int checkpoint=((Number)player.get("checkpoint")).intValue();
            if(checkpoint>=room.race.questions.size())return Map.of("done",true);
            var q=room.race.questions.get(checkpoint);var order=RushCompetition.order(room.race,racer,checkpoint);int index=0;for(int i=0;i<order.size();i++)if(q.options().get(order.get(i)).id().equals(q.answerId()))index=i;
            return Map.of("checkpoint",checkpoint,"answerId",q.answerId(),"index",index,"state",state,"sourceId",q.sourceId(),"fingerprint",q.fingerprint());
        }
        /** Render stress only: source-backed gates/exact positions in disposable fixture, never gameplay evidence. */
        @PostMapping("/fixture/competitive/scenario/{id}") Map<String,Object> scenario(@org.springframework.security.core.annotation.AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id,@RequestBody Map<String,Object> input)throws Exception{
            synchronized(service){
                service.get(user.getId(),id);var field=RushCompetitiveService.class.getDeclaredField("rooms");field.setAccessible(true);
                var room=((Map<UUID,RushCompetitiveService.Room>)field.get(service)).get(id);assertEquals(room.owner,user.getId());
                var item=corpus.challenge((String)input.get("sourceId"));assertTrue(questions.qualified(item));int count=((Number)input.get("gates")).intValue();assertTrue(count>=2&&count<=4&&count<=item.options().size());
                var labels=new ArrayList<String>();labels.add(item.canonical());labels.addAll(item.options().stream().filter(o->!com.englishcoach.kingofenglish.KingBank.correct(item,o,null)).limit(count-1).toList());
                var options=labels.stream().map(s->new RushDtos.Option(UUID.randomUUID(),s)).toList();var q=new RushQuestions.Pinned(UUID.randomUUID(),item.id(),item.fingerprint(),item.family(),item.prompt(),Objects.toString(item.context(),""),options,options.getFirst().id(),item.canonical(),item.meaning(),item.sourceRef());
                room.race.questions=List.of(q,q,q);room.race.status="RUNNING";room.race.elapsed=0;room.race.firstFinish=-1;room.recovery="";
                int visible=((Number)input.getOrDefault("visible",5)).intValue();assertTrue(visible>=1&&visible<=5);
                for(var p:room.race.racers){p.checkpoint=0;p.x=500;p.y=Integer.parseInt(p.id.substring(1))<=visible?room.race.spacing-1600:0;p.vx=0;p.speed=0;p.phase="RUNNING";p.target=null;p.horizontal=0;p.sprint=false;p.inputAt=-100;p.seenAt=0;p.orders.clear();p.tried.clear();p.selected=-1;p.openGate=-1;p.rejected=-1;p.phaseTime=0;p.finishAt=-1;p.rank=0;p.effect="";p.effectUntil=0;}
                room.race.revision++;return service.view(room,user.getId());
            }
        }
        @GetMapping("/fixture/competitive/metrics") Map<String,Object> metrics(){return service.metrics();}
    }
    /** Test-only network emulation for the fixture database: ordered, per-direction delayed TCP relay. */
    static final class DbDelay {
        static String wrap(String url,long delayMs)throws java.io.IOException{
            if(delayMs<=0)return url;var m=java.util.regex.Pattern.compile("jdbc:postgresql://([^:/]+):(\\d+)(/.*)").matcher(url);if(!m.matches())throw new IllegalStateException(url);
            String host=m.group(1);int port=Integer.parseInt(m.group(2));var server=new java.net.ServerSocket(0,50,java.net.InetAddress.getLoopbackAddress());
            var accept=new Thread(()->{while(!server.isClosed())try{var client=server.accept();var upstream=new java.net.Socket(host,port);client.setTcpNoDelay(true);upstream.setTcpNoDelay(true);relay(client,upstream,delayMs);relay(upstream,client,delayMs);}catch(java.io.IOException e){return;}},"db-delay-accept");
            accept.setDaemon(true);accept.start();System.out.println("RUSH_FIXTURE_DB_DELAY "+delayMs+" ms each way via port "+server.getLocalPort());
            return "jdbc:postgresql://127.0.0.1:"+server.getLocalPort()+m.group(3);
        }
        private record Chunk(long due,byte[] bytes){}
        private static void relay(java.net.Socket from,java.net.Socket to,long delayMs){
            var queue=new java.util.concurrent.LinkedBlockingQueue<Chunk>();
            var reader=new Thread(()->{try(var in=from.getInputStream()){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))>0)queue.put(new Chunk(System.nanoTime()+delayMs*1_000_000,java.util.Arrays.copyOf(buffer,n)));}catch(Exception ignored){}try{queue.put(new Chunk(System.nanoTime()+delayMs*1_000_000,null));}catch(InterruptedException ignored){}},"db-delay-read");
            var writer=new Thread(()->{try{var out=to.getOutputStream();while(true){var c=queue.take();long wait=c.due()-System.nanoTime();if(wait>0)Thread.sleep(wait/1_000_000,(int)(wait%1_000_000));if(c.bytes()==null){to.shutdownOutput();return;}out.write(c.bytes());out.flush();}}catch(Exception e){try{to.close();from.close();}catch(java.io.IOException ignored){}}},"db-delay-write");
            reader.setDaemon(true);writer.setDaemon(true);reader.start();writer.start();
        }
    }
    @Test void serve()throws Exception {
        try(var pg=new PostgreSQLContainer<>("postgres:17")){
            // -Dquizrush.fixture.dbDelayMs=N: the application reaches PostgreSQL through a local proxy that delays every chunk N ms
            // each way, like the production database (an external server ~90–115 ms per round trip). Default 0: direct.
            pg.start();String appUrl=DbDelay.wrap(pg.getJdbcUrl(),Long.getLong("quizrush.fixture.dbDelayMs",0));var ds=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());new JdbcTemplate(ds).execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY);INSERT INTO public.users VALUES(1),(2),(3),(4),(5),(6);CREATE SCHEMA exams;CREATE TABLE exams.test_baseline(id INT)");
            // Test-only isolated subset: concurrent Garden V80 requires unrelated schemas; never a production stream.
            Path migrations=Files.createTempDirectory("rush-phase3-migrations-");for(String name:List.of("V79__echo_quiz_rush_solo.sql","V81__echo_quiz_rush_competitive.sql")){try(var in=getClass().getResourceAsStream("/db/migration/exams/"+name)){Files.copy(Objects.requireNonNull(in),migrations.resolve(name));}}
            try(var app=new SpringApplicationBuilder(Fixture.class).properties(Map.ofEntries(
                Map.entry("server.address","127.0.0.1"),Map.entry("server.port","8989"),Map.entry("spring.datasource.url",appUrl),Map.entry("spring.datasource.username",pg.getUsername()),Map.entry("spring.datasource.password",pg.getPassword()),
                Map.entry("spring.flyway.enabled","true"),Map.entry("spring.flyway.locations","filesystem:"+migrations),Map.entry("spring.flyway.schemas","exams"),Map.entry("spring.flyway.default-schema","exams"),Map.entry("spring.flyway.baseline-on-migrate","true"),Map.entry("spring.flyway.baseline-version","78"),Map.entry("spring.flyway.target","81"),Map.entry("king.content-channel","REVIEW_PREVIEW"),Map.entry("king.snapshot-store",""),
                Map.entry("CORS_ALLOWED_ORIGINS","http://localhost:3107,http://127.0.0.1:3107,http://localhost:3207,http://127.0.0.1:3207"),Map.entry("logging.level.root","WARN"))).run("--spring.config.location=optional:classpath:/quizrush-fixture-empty.properties")){
                System.out.println("RUSH_COMPETITIVE_READY localhost:8989; disposable PG17; production broker; synthetic principals");
                long until=System.nanoTime()+Duration.ofMinutes(Long.getLong("quizrush.fixture.minutes",45)).toNanos();while(System.nanoTime()<until&&!Files.exists(Path.of("target/rush-competitive-stop")))Thread.sleep(1000);
                assertNotNull(app.getBean(RushCompetitiveController.class));
            }finally{for(String n:List.of("V79__echo_quiz_rush_solo.sql","V81__echo_quiz_rush_competitive.sql"))Files.deleteIfExists(migrations.resolve(n));Files.deleteIfExists(migrations);}
        }
    }
}
