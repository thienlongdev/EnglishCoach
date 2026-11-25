package com.englishcoach.quizrush;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.kingofenglish.KingCorpus;
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
import static org.mockito.Mockito.*;
import static org.junit.jupiter.api.Assertions.*;

/** Explicit opt-in localhost fixture; never component-scanned or shipped in app.jar. */
@EnabledIfSystemProperty(named="quizrush.browser",matches="true")
class RushBrowserFixtureTest {
    @Configuration
    @EnableAutoConfiguration(exclude={org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({RushController.class,RushService.class,RushRepository.class,RushQuestions.class,RushExceptionHandler.class,KingCorpus.class,RushExposureStore.class,Truth.class})
    static class Fixture {
        @Bean LoginThrottleService throttle(){var t=mock(LoginThrottleService.class);when(t.checkAndIncrementRateLimit(anyString(),anyString(),anyInt(),anyInt())).thenReturn(true);return t;}
        @Bean JwtDecoder decoder(){return token->{if(!Set.of("rush-fixture-user1","rush-fixture-user2").contains(token))throw new JwtException("Local fixture only");return new Jwt(token,Instant.now(),Instant.now().plusSeconds(3600),Map.of("alg","fixture-only"),Map.of("sub",token.endsWith("1")?"1":"2"));};}
        @Bean SecurityFilterChain security(HttpSecurity http)throws Exception {
            return http.csrf(c->c.disable()).authorizeHttpRequests(a->a.anyRequest().authenticated()).oauth2ResourceServer(o->o.jwt(j->j.jwtAuthenticationConverter(jwt->{long id=Long.parseLong(jwt.getSubject());var u=new UserDetailsImpl(id,"fixture"+id+"@example.test","",List.of());return new UsernamePasswordAuthenticationToken(u,null,u.getAuthorities());}))).build();
        }
    }
    @RestController static class Truth {
        private final RushRepository repo;
        Truth(RushRepository repo){this.repo=repo;}
        @GetMapping("/fixture/truth/{id}") Map<String,Object> truth(@org.springframework.security.core.annotation.AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID id){var race=repo.get(user.getId(),id);if(race.checkpoint==race.questions.size())return Map.of("done",true);var q=race.questions.get(race.checkpoint);return Map.of("answerId",q.answerId(),"sourceId",q.sourceId(),"index",q.options().stream().map(RushDtos.Option::id).toList().indexOf(q.answerId()));}
    }
    @Test void serveRealSourceRealPersistence()throws Exception {
        try(var pg=new PostgreSQLContainer<>("postgres:17")){
            pg.start();var ds=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());new JdbcTemplate(ds).execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY);INSERT INTO public.users VALUES(1),(2);CREATE SCHEMA exams;CREATE TABLE exams.test_baseline(id INT)");
            try(var app=new SpringApplicationBuilder(Fixture.class).properties(Map.ofEntries(
                Map.entry("server.address","127.0.0.1"),Map.entry("server.port","8987"),Map.entry("spring.datasource.url",pg.getJdbcUrl()),Map.entry("spring.datasource.username",pg.getUsername()),Map.entry("spring.datasource.password",pg.getPassword()),
                Map.entry("spring.flyway.enabled","true"),Map.entry("spring.flyway.locations","classpath:db/migration/exams"),Map.entry("spring.flyway.schemas","exams"),Map.entry("spring.flyway.default-schema","exams"),Map.entry("spring.flyway.baseline-on-migrate","true"),Map.entry("spring.flyway.baseline-version","78"),Map.entry("spring.flyway.target","79"),Map.entry("king.content-channel","REVIEW_PREVIEW"),Map.entry("king.snapshot-store",""))).run("--spring.config.location=optional:classpath:/quizrush-fixture-empty.properties")){
                System.out.println("RUSH_BROWSER_READY localhost:8987 disposable PG17; synthetic principals; no production connectivity");
                long until=System.nanoTime()+Duration.ofMinutes(20).toNanos();while(System.nanoTime()<until&&!java.nio.file.Files.exists(java.nio.file.Path.of("target/rush-browser-stop")))Thread.sleep(1000);
                assertNotNull(app.getBean(RushController.class));
            }
        }
    }
}
