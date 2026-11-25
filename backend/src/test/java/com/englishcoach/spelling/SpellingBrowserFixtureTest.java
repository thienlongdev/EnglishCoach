package com.englishcoach.spelling;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.*;
import com.englishcoach.flashcard.pvp.config.WebSocketConfig;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.kingofenglish.KingCorpus;
import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.web.SecurityFilterChain;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Real broker/game/audio/Sentinel/PostgreSQL; SYNTHETIC local accounts. Never packaged or claimed as two-human acceptance. */
@EnabledIfSystemProperty(named="spelling.browser",matches="true")
class SpellingBrowserFixtureTest {
    static DriverManagerDataSource source;
    @Configuration @EnableAutoConfiguration(exclude={org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration.class,
        org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration.class,
        org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({WebSocketConfig.class,StompAuthChannelInterceptor.class,SpellingChannelGuard.class,SpellingController.class,
        SpellingService.class,SpellingResults.class,SpellingEvents.class,SentinelService.class,SentinelController.class,Truth.class})
    static class Fixture {
        @Bean JdbcTemplate jdbc(){return new JdbcTemplate(source);}
        @Bean org.springframework.transaction.PlatformTransactionManager transactions(){return new DataSourceTransactionManager(source);}
        @Bean KingCorpus corpus(){return new KingCorpus("REVIEW_PREVIEW");}
        @Bean SpellingCatalog catalog(com.fasterxml.jackson.databind.ObjectMapper json,KingCorpus corpus)throws Exception{
            var root=json.readTree(Files.readString(Path.of("src/main/resources/data/spelling/catalog.json")));
            var sequence=new ArrayList<SpellingCatalog.Word>();
            for(String word:List.of("ocean","garden","tomato","mother")){
                var w=root.path("words").findValues("word");
                for(var a:root.path("audio"))if(a.path("key").asText().equals(word))sequence.add(new SpellingCatalog.Word(word,0,"fixture-order-of-real-catalog","",new SpellingCatalog.Clip(a.path("file").asText(),a.path("durationMs").asLong(),a.path("sha256").asText())));
            }
            return new SpellingCatalog(json,corpus){@Override public Word choose(int tier,Set<String> used){
                // Deterministic local test order only, to allow keyboard-driven timed journeys without inspecting hidden state.
                return sequence.stream().filter(w->!used.contains(w.word())).findFirst().orElseGet(()->super.choose(tier,used));
            }};
        }
        @Bean CardBlastPvPService cardBlast(){return mock(CardBlastPvPService.class);}
        @Bean AuthSecurityProperties properties(org.springframework.core.env.Environment e){return new AuthSecurityProperties(e);}
        @Bean LoginThrottleService throttle(){var t=mock(LoginThrottleService.class);when(t.checkAndIncrementRateLimit(anyString(),anyString(),anyInt(),anyInt())).thenReturn(true);return t;}
        @Bean JwtDecoder decoder(){return token->{if(!token.matches("spelling-fixture-user[1-2]"))throw new JwtException("Local fixture only");return new Jwt(token,Instant.now(),Instant.now().plusSeconds(7200),Map.of("alg","fixture"),Map.of("sub",token.substring(token.length()-1)));};}
        @Bean CustomJwtAuthenticationConverter converter(){var c=mock(CustomJwtAuthenticationConverter.class);when(c.convert(any(Jwt.class))).thenAnswer(inv->{Jwt j=inv.getArgument(0);long id=Long.parseLong(j.getSubject());var u=new UserDetailsImpl(id,"fixture"+id+"@example.test","",List.of());return new UsernamePasswordAuthenticationToken(u,null,u.getAuthorities());});return c;}
        @Bean SecurityFilterChain security(HttpSecurity http,CustomJwtAuthenticationConverter c)throws Exception{return http.csrf(x->x.disable()).authorizeHttpRequests(x->x.requestMatchers("/ws-card-blast").permitAll().anyRequest().authenticated()).oauth2ResourceServer(x->x.jwt(j->j.jwtAuthenticationConverter(c))).build();}
    }
    @org.springframework.web.bind.annotation.RestController static class Truth {
        final SpellingService service;Truth(SpellingService service){this.service=service;}
        @org.springframework.web.bind.annotation.GetMapping("/fixture/truth") public Map<String,Object> truth(@org.springframework.security.core.annotation.AuthenticationPrincipal UserDetailsImpl user)throws Exception{
            var f=SpellingService.class.getDeclaredField("rooms");f.setAccessible(true);
            @SuppressWarnings("unchecked") var rooms=(Map<UUID,SpellingMatch>)f.get(service);
            for(var r:rooms.values())synchronized(r){if(r.members.containsKey(user.getId())&&!r.terminal()&&r.word!=null)return Map.of("word",r.word.word(),"turn",r.turnId,"phase",r.phase,"speaker",r.active.id);}
            return Map.of("none",true);
        }
    }
    @Test void serve()throws Exception{
        try(var pg=new PostgreSQLContainer<>("postgres:17")){
            pg.start();source=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());var sql=new JdbcTemplate(source);
            sql.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY,name text,role text DEFAULT 'ROLE_USER',account_status text DEFAULT 'ACTIVE');INSERT INTO public.users(id,name) VALUES(1,'Local Lyra'),(2,'Local Kai');CREATE TABLE public.user_profiles(user_id BIGINT PRIMARY KEY,display_name text);");
            for(String file:List.of("V105__king_conquest_results.sql","V113__king_conquest_unlimited_score.sql","V119__echo_sentinel_attempts.sql","V127__echo_spelling_results.sql"))sql.execute(Files.readString(Path.of("src/main/resources/db/migration/exams",file)));
            try(var app=new SpringApplicationBuilder(Fixture.class).properties("spring.config.location=optional:classpath:spelling-fixture-empty.properties","server.address=127.0.0.1","server.port=8998","spring.main.banner-mode=off","logging.level.root=WARN","CORS_ALLOWED_ORIGINS=http://localhost:3311,http://localhost:3312,http://127.0.0.1:3311,http://127.0.0.1:3312").run()){
                assertTrue(app.getBean(SpellingCatalog.class).available(),"The actual packaged OmniVoice/catalog must be complete");
                System.out.println("SPELLING_BROWSER_READY 127.0.0.1:8998; REAL engine/audio/PG, SYNTHETIC users; words="+app.getBean(SpellingCatalog.class).counts());
                long end=System.nanoTime()+Duration.ofMinutes(120).toNanos();
                while(System.nanoTime()<end&&!Files.exists(Path.of("target/spelling-browser-stop")))Thread.sleep(1000);
            }
        }
    }
}
