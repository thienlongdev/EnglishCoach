package com.englishcoach.kingofenglish;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.common.security.*;
import com.englishcoach.flashcard.pvp.config.WebSocketConfig;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.web.SecurityFilterChain;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Explicit localhost-only browser fixture for the King Of English UI (Royal Rebirth QA): the real King broker, service, engines
 * and the bundled source-backed corpus (REVIEW_PREVIEW), synthetic principals king-fixture-user1–6. No database.
 * Run: mvn -f backend/pom.xml test -Dtest=KingBrowserFixtureTest -Dking.browser=true -Dking.fixture.minutes=90
 * Stop early: create backend/target/king-browser-stop.
 */
@EnabledIfSystemProperty(named="king.browser",matches="true")
class KingBrowserFixtureTest {
    @Configuration
    @EnableAutoConfiguration(exclude={org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration.class,
        org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,
        org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration.class,
        org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({WebSocketConfig.class,StompAuthChannelInterceptor.class,KingChannelGuard.class,KingController.class,KingService.class,KingCorpus.class,KingBank.class,KingExplainBank.class,KingConquestBank.class,
        com.englishcoach.dictionary.service.LocalGameLexicon.class,com.englishcoach.dictionary.provider.LocalEnViLexicalProvider.class,com.englishcoach.dictionary.provider.KaikkiLocalLexicalStore.class,Truth.class,com.englishcoach.sentinel.SentinelController.class})
    static class Fixture {
        @Bean CardBlastPvPService cardBlast(){return mock(CardBlastPvPService.class);}
        /** Soán ngôi results kept in memory (no database here): the same ranking rule as V105 for the QA journey. */
        @Bean KingConquestResults conquestResults(){return new MemoryResults();}
        /** Echo Sentinel with its decisions kept in memory (no database here); same state machine as production. */
        @Bean com.englishcoach.sentinel.SentinelService sentinel(){
            return new com.englishcoach.sentinel.SentinelService(new com.englishcoach.sentinel.SentinelStore(null){
                @Override public void write(com.englishcoach.sentinel.SentinelAttempt.Change c){System.out.println("SENTINEL "+c.attempt().id()+" "+c.from()+" -> "+c.to()+" "+c.kind()+" "+c.detail());}
                @Override public void writeLater(com.englishcoach.sentinel.SentinelAttempt.Change c){if(c!=null)write(c);}
            },Clock.systemUTC());
        }
        /** Non-production properties: the socket handshake authenticates from the dev session cookie (ec_at). */
        @Bean AuthSecurityProperties authSecurityProperties(org.springframework.core.env.Environment environment){return new AuthSecurityProperties(environment);}
        @Bean LoginThrottleService throttle(){var t=mock(LoginThrottleService.class);when(t.checkAndIncrementRateLimit(anyString(),anyString(),anyInt(),anyInt())).thenReturn(true);return t;}
        @Bean JwtDecoder decoder(){return token->{
            if(!token.matches("king-fixture-user[1-6]"))throw new JwtException("Local fixture only");
            return new Jwt(token,Instant.now(),Instant.now().plusSeconds(3600),Map.of("alg","fixture-only"),Map.of("sub",token.substring(token.length()-1)));
        };}
        @Bean CustomJwtAuthenticationConverter converter(){
            var c=mock(CustomJwtAuthenticationConverter.class);
            when(c.convert(any(Jwt.class))).thenAnswer(inv->{Jwt jwt=inv.getArgument(0);long id=Long.parseLong(jwt.getSubject());
                var u=new UserDetailsImpl(id,"king"+id+"@example.test","",List.of());return new UsernamePasswordAuthenticationToken(u,null,u.getAuthorities());});
            return c;
        }
        @Bean SecurityFilterChain security(HttpSecurity http,CustomJwtAuthenticationConverter c)throws Exception{
            return http.csrf(x->x.disable()).authorizeHttpRequests(x->x.requestMatchers("/ws-card-blast").permitAll().anyRequest().authenticated())
                .oauth2ResourceServer(x->x.jwt(j->j.jwtAuthenticationConverter(c))).build();
        }
    }
    static final class MemoryResults extends KingConquestResults {
        final List<Row> rows=Collections.synchronizedList(new ArrayList<>());
        @SuppressWarnings("unchecked") MemoryResults(){super(null,mock(org.springframework.beans.factory.ObjectProvider.class));}
        @Override void save(List<Row> list){for(var r:list)if(rows.stream().noneMatch(x->x.match().equals(r.match())&&x.user()==r.user()))rows.add(r);}
        @Override public Map<String,Object> board(long viewer,int size,String category){
            KingConfig.conquestMs(size);
            var best=new LinkedHashMap<Long,Row>();
            synchronized(rows){for(var r:rows)if(r.size()==size&&r.category().equals(category))best.merge(r.user(),r,(a,b)->b.score()>a.score()?b:a);}
            var ordered=best.values().stream().sorted(Comparator.comparingInt(Row::score).reversed().thenComparing(Row::at)).toList();
            var top=new ArrayList<Map<String,Object>>();
            for(var r:ordered.subList(0,Math.min(5,ordered.size())))top.add(Map.of("rank",top.size()+1,"name","Fixture learner "+r.user(),"score",r.score(),"achievedAt",r.at().toString(),"you",r.user()==viewer));
            var out=new LinkedHashMap<String,Object>();out.put("size",size);out.put("category",category);out.put("top",top);
            var mine=best.get(viewer);
            out.put("you",mine==null?null:Map.of("best",mine.score(),"achievedAt",mine.at().toString(),"rank",ordered.indexOf(mine)+1));
            return out;
        }
    }
    /** Test-only answer oracle for the automated journey: the caller's own current item (never part of the application). */
    @org.springframework.web.bind.annotation.RestController static class Truth {
        private final KingService service;private final KingBank bank;private final KingExplainBank explain;private final KingConquestBank conquest;
        Truth(KingService service,KingBank bank,KingExplainBank explain,KingConquestBank conquest){this.service=service;this.bank=bank;this.explain=explain;this.conquest=conquest;}
        @SuppressWarnings("unchecked")
        @org.springframework.web.bind.annotation.GetMapping("/fixture/king/truth") Map<String,Object> truth(@org.springframework.security.core.annotation.AuthenticationPrincipal UserDetailsImpl user)throws Exception{
            synchronized(service){
                var rf=KingService.class.getDeclaredField("rooms");rf.setAccessible(true);var mf=KingService.class.getDeclaredField("membership");mf.setAccessible(true);
                var room=((Map<String,KingService.Room>)rf.get(service)).get(((Map<Long,String>)mf.get(service)).get(user.getId()));
                if(room==null||!room.status.equals("PLAYING"))return Map.of("none",true);
                var out=new LinkedHashMap<String,Object>();out.put("mode",room.mode);
                if(room.mode.equals("EXPLAIN"))out.put("answer",explain.get(room.ids.get(room.round)).target());
                else if(room.mode.equals("CONQUEST")){
                    out.put("candidates",room.conquest.candidates.stream().filter(c->!room.conquest.used.contains(c.word().toLowerCase(Locale.ROOT))).map(c->Map.of("word",c.word(),"path",c.path())).toList());
                }else{
                    var p=room.players.get(user.getId());int slot=room.mode.equals("REORDER")?room.round:(p.queue.isEmpty()?-1:p.queue.peek());
                    if(slot<0)return Map.of("none",true);
                    var i=bank.get(room.ids.get(slot));out.put("answer",i.canonical());
                    if(!i.tokens().isEmpty()){
                        var words=i.mode().equals("REORDER")?Arrays.asList(KingBank.normalize(i.canonical()).split(" ")):Arrays.asList(i.canonical().split(""));
                        var remaining=new ArrayList<Integer>();for(int n=0;n<i.tokens().size();n++)remaining.add(n);var order=new ArrayList<Integer>();
                        // tokens may be multi-word chunks: greedily match the canonical text in sequence
                        String rest=String.join(" ",words);
                        while(!remaining.isEmpty()){final String r=rest;
                            var id=remaining.stream().filter(n->{String t=KingBank.normalize(i.tokens().get(n));return i.mode().equals("REORDER")?(r.equals(t)||r.startsWith(t+" ")):r.startsWith(t);}).findFirst().orElse(null);
                            if(id==null)break;order.add(id);remaining.remove(id);String t=KingBank.normalize(i.tokens().get(id));rest=rest.substring(Math.min(rest.length(),t.length())).strip();}
                        out.put("order",order);out.put("tokens",i.tokens());
                    }
                }
                return out;
            }
        }
    }
    @Test void serve()throws Exception{
        try(var app=new SpringApplicationBuilder(Fixture.class).properties(
            "spring.config.location=optional:classpath:king-fixture-empty.properties","server.address=127.0.0.1","server.port="+Integer.getInteger("king.fixture.port",8990),
            "king.engineering=true","king.content-channel="+System.getProperty("king.fixtureChannel","REVIEW_PREVIEW"),"spring.main.banner-mode=off","logging.level.root=WARN",
            "CORS_ALLOWED_ORIGINS=http://localhost:3207,http://127.0.0.1:3207,http://localhost:3208,http://127.0.0.1:3208").run()){
            System.out.println("KING_BROWSER_READY localhost:"+Integer.getInteger("king.fixture.port",8990)+"; real King broker; synthetic principals");
            long until=System.nanoTime()+Duration.ofMinutes(Long.getLong("king.fixture.minutes",60)).toNanos();
            while(System.nanoTime()<until&&!Files.exists(Path.of("target/king-browser-stop")))Thread.sleep(1000);
            assertNotNull(app.getBean(KingService.class));
        }
    }
}
