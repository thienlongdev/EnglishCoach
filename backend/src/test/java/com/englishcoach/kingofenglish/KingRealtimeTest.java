package com.englishcoach.kingofenglish;

import com.englishcoach.common.security.*;
import com.englishcoach.flashcard.pvp.config.WebSocketConfig;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.annotation.*;
import org.springframework.messaging.converter.MappingJackson2MessageConverter;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;
import java.lang.reflect.Type;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Isolated real broker fixture. No component scan, DataSource, JPA, Flyway or DB beans. */
class KingRealtimeTest {
    @Configuration
    @EnableAutoConfiguration(exclude={org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration.class,
        org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,
        org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration.class,
        org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({WebSocketConfig.class,StompAuthChannelInterceptor.class,KingChannelGuard.class,KingController.class,KingService.class,KingCorpus.class,KingBank.class,KingExplainBank.class,KingConquestBank.class,com.englishcoach.dictionary.service.LocalGameLexicon.class,com.englishcoach.dictionary.provider.LocalEnViLexicalProvider.class,com.englishcoach.dictionary.provider.KaikkiLocalLexicalStore.class})
    static class Fixture {
        @Bean CardBlastPvPService cardBlast(){return mock(CardBlastPvPService.class);}
        @Bean JwtDecoder decoder(){return token->{
            if(!Set.of("king-fixture-1","king-fixture-2","king-fixture-3").contains(token))throw new JwtException("Fixture token rejected");
            return new Jwt(token,Instant.now(),Instant.now().plusSeconds(3600),Map.of("alg","test-only"),Map.of("sub",token.substring(13)));
        };}
        @Bean CustomJwtAuthenticationConverter converter(){
            var c=mock(CustomJwtAuthenticationConverter.class);
            when(c.convert(any(Jwt.class))).thenAnswer(inv->{
                Jwt jwt=inv.getArgument(0);long id=Long.parseLong(jwt.getSubject());
                var user=new UserDetailsImpl(id,"king"+id+"@example.test","",List.of());
                return new UsernamePasswordAuthenticationToken(user,null,user.getAuthorities());
            });return c;
        }
        @Bean SecurityFilterChain security(HttpSecurity http,CustomJwtAuthenticationConverter c)throws Exception{
            return http.csrf(x->x.disable()).authorizeHttpRequests(x->x.requestMatchers("/ws-card-blast").permitAll().anyRequest().authenticated())
                .oauth2ResourceServer(x->x.jwt(j->j.jwtAuthenticationConverter(c))).build();
        }
    }
    static class Peer implements AutoCloseable{
        final WebSocketStompClient client=new WebSocketStompClient(new StandardWebSocketClient());
        final BlockingQueue<Map<String,Object>> events=new LinkedBlockingQueue<>();
        final long user;StompSession socket;
        Peer(int port,long user)throws Exception{
            this.user=user;client.setMessageConverter(new MappingJackson2MessageConverter());
            var headers=new StompHeaders();headers.add("Authorization","Bearer king-fixture-"+user);
            socket=client.connectAsync("ws://localhost:"+port+"/ws-card-blast",new org.springframework.web.socket.WebSocketHttpHeaders(),headers,new StompSessionHandlerAdapter(){}).get(10,TimeUnit.SECONDS);
            socket.subscribe("/user/queue/king-of-english",new StompFrameHandler(){
                public Type getPayloadType(StompHeaders h){return Map.class;}
                @SuppressWarnings("unchecked")public void handleFrame(StompHeaders h,Object p){events.offer((Map<String,Object>)p);}
            });
            // Command ACK proves private subscription before test assertions.
            command("rejoin",Map.of("roomCode",""));
        }
        Map<String,Object> command(String action,Map<String,Object> payload)throws Exception{
            var body=new HashMap<>(payload);String id=UUID.randomUUID().toString();body.putIfAbsent("messageId",id);id=(String)body.get("messageId");
            socket.send("/app/king-of-english/"+action,body);
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(System.nanoTime()<until){var e=events.poll(200,TimeUnit.MILLISECONDS);if(e!=null&&id.equals(e.get("messageId")))return e;}
            throw new AssertionError("No ACK/ERROR for "+action);
        }
        public void close(){if(socket!=null&&socket.isConnected())socket.disconnect();client.stop();}
    }
    @SuppressWarnings("unchecked") static Map<String,Object> state(Map<String,Object> e){assertEquals("ACK",e.get("type"),e.toString());return (Map<String,Object>)e.get("state");}
    static Map<String,Object> scope(Map<String,Object> s){
        return Map.of("roomCode",s.get("roomCode"),"matchId",s.get("matchId"),"round",s.get("round"),"revision",s.get("inputRevision"));
    }
    @SuppressWarnings("unchecked") static Map<String,Object> truth(KingBank bank,Map<String,Object> s){
        var i=bank.get((String)((Map<String,Object>)s.get("challenge")).get("id"));
        var body=new HashMap<>(scope(s));body.put("answer",i.canonical());
        if(!i.tokens().isEmpty()){
            var words=i.mode().equals("REORDER")?KingBank.normalize(i.canonical()).split(" "):i.canonical().split("");
            var remaining=new ArrayList<Integer>();for(int n=0;n<i.tokens().size();n++)remaining.add(n);
            var order=new ArrayList<Integer>();for(String word:words){int id=remaining.stream().filter(n->KingBank.normalize(i.tokens().get(n)).equals(word)).findFirst().orElseThrow();order.add(id);remaining.remove(Integer.valueOf(id));}
            body.put("order",order);
        }return body;
    }
    static ServletWebServerApplicationContext context(int port){
        return (ServletWebServerApplicationContext)new SpringApplicationBuilder(Fixture.class).properties(
            "spring.config.location=optional:classpath:king-fixture-empty.properties","server.port="+port,
            "king.engineering=true","king.content-channel="+System.getProperty("king.fixtureChannel","ENGINEERING"),"spring.main.banner-mode=off","logging.level.root=WARN",
            "CORS_ALLOWED_ORIGINS=http://localhost:3142,http://localhost:3143").run();
    }
    @Test void realTwoClientEightFlowProtocolAndIsolation()throws Exception{
        try(var app=context(0)){
            int port=app.getWebServer().getPort();var bank=app.getBean(KingBank.class);
            assertFalse(app.containsBean("dataSource"));
            for(String mode:List.of("REORDER","REFLEX")){
                for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
                    try(var a=new Peer(port,1);var b=new Peer(port,2);var outsider=new Peer(port,3)){
                        String action=flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start";
                        var s=state(a.command(action,Map.of("mode",mode,"flow",flow,"length",5,"difficulty",0,"bot","MEDIUM")));
                        String code=(String)s.get("roomCode");
                        if(flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM")){
                            state(b.command(flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?Map.of("mode",mode):Map.of("roomCode",code)));
                            state(a.command("ready",Map.of("roomCode",code)));state(b.command("ready",Map.of("roomCode",code)));
                            s=state(a.command("ping",Map.of("roomCode",code)));
                            var forged=new HashMap<>(truth(bank,s));forged.put("userId",1);forged.put("score",999);
                            assertEquals("NOT_A_MEMBER",outsider.command("answer",forged).get("code"));
                        }
                        assertEquals("PLAYING",s.get("status"));
                        var serialized=new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(s);
                        assertFalse(serialized.contains("canonical"));assertFalse(serialized.contains("accepted"));assertFalse(serialized.contains("\"answer\":"));
                        var body=truth(bank,s);body.put("messageId","one-answer");body.put("score",999);body.put("winnerId",1);
                        var accepted=state(a.command("answer",body));assertEquals(mode.equals("REORDER")&&flow.equals("SOLO")?10:1,((Number)accepted.get("score")).intValue());
                        var replay=state(a.command("answer",body));assertEquals(accepted.get("score"),replay.get("score"));
                        assertEquals("NOT_A_MEMBER",outsider.command("rejoin",Map.of("roomCode",code)).get("code"));
                        a.close();
                        Thread.sleep(100);
                        try(var returned=new Peer(port,1)){
                            var recovered=state(returned.command("rejoin",Map.of("roomCode",code)));assertEquals(accepted.get("score"),recovered.get("score"));assertEquals(s.get("matchId"),recovered.get("matchId"));
                            if(mode.equals("REFLEX")){
                                var stale=returned.command("answer",new HashMap<>(body){{put("messageId","stale-new");}});
                                assertEquals("STALE_ROUND",stale.get("code"));
                            }
                            var end=state(returned.command("leave",Map.of("roomCode",code)));assertEquals("FINISHED",end.get("status"));
                            assertNotNull(app.getBean(KingService.class).result(1,(String)end.get("matchId")));
                            assertThrows(KingService.Rejection.class,()->app.getBean(KingService.class).result(3,(String)end.get("matchId")));
                            if(flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM"))b.command("leave",Map.of("roomCode",code));
                        }
                        System.out.println("KING_TWO_CLIENT_VERIFIED "+mode+"/"+flow);
                    }
                }
            }
        }
    }
    @Test void browserFixture()throws Exception{
        if(!Boolean.getBoolean("king.browser"))return;
        try(var app=context(18083)){
            System.out.println("KING_BROWSER_READY port=18083 synthetic-auth real-engine no-DB");
            Thread.sleep(1_500_000);
        }
    }
}

