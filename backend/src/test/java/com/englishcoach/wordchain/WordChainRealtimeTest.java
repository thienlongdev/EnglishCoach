package com.englishcoach.wordchain;

import com.englishcoach.common.security.*;
import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import com.englishcoach.flashcard.pvp.config.WebSocketConfig;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
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

class WordChainRealtimeTest {
    @Configuration
    @org.springframework.scheduling.annotation.EnableScheduling
    @EnableAutoConfiguration(exclude={DataSourceAutoConfiguration.class,HibernateJpaAutoConfiguration.class,FlywayAutoConfiguration.class,
        org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({WebSocketConfig.class,StompAuthChannelInterceptor.class,WordChainChannelGuard.class,WordChainController.class,
             WordChainService.class,WordChainResults.class,com.englishcoach.progress.service.LearningEventService.class,
             WordChainLexicon.class,LocalGameLexicon.class,LocalEnViLexicalProvider.class,KaikkiLocalLexicalStore.class,
             com.englishcoach.flashcard.pvp.controller.CardBlastPvPController.class,
             com.englishcoach.common.security.AuthSecurityProperties.class})
    static class Fixture {
        @Bean(initMethod="start",destroyMethod="stop") org.testcontainers.containers.PostgreSQLContainer<?> database() {
            return new org.testcontainers.containers.PostgreSQLContainer<>("postgres:17");
        }
        @Bean javax.sql.DataSource dataSource(org.testcontainers.containers.PostgreSQLContainer<?> db) {
            var ds=new org.springframework.jdbc.datasource.DriverManagerDataSource(db.getJdbcUrl(),db.getUsername(),db.getPassword());
            var jdbc=new org.springframework.jdbc.core.JdbcTemplate(ds);
            jdbc.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY); INSERT INTO public.users VALUES(1),(2),(3); CREATE SCHEMA exams; CREATE TABLE exams.test_baseline(id INT)");
            jdbc.execute("CREATE TABLE public.learning_activity_events(user_id BIGINT NOT NULL REFERENCES public.users(id), activity_type TEXT NOT NULL, source_ref TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, UNIQUE(user_id,activity_type,source_ref))");
            org.flywaydb.core.Flyway.configure().dataSource(ds).schemas("exams").defaultSchema("exams")
                .locations("classpath:db/migration/exams").baselineOnMigrate(true).baselineVersion("69").target("70").load().migrate();
            return ds;
        }
        @Bean org.springframework.jdbc.core.JdbcTemplate jdbc(javax.sql.DataSource ds){return new org.springframework.jdbc.core.JdbcTemplate(ds);}
        @Bean org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate namedJdbc(javax.sql.DataSource ds){return new org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate(ds);}
        @Bean org.springframework.transaction.PlatformTransactionManager transactions(javax.sql.DataSource ds){return new org.springframework.jdbc.datasource.DataSourceTransactionManager(ds);}
        @Bean CardBlastPvPService cardBlast(org.springframework.messaging.simp.SimpMessagingTemplate template){
            var cards = mock(com.englishcoach.flashcard.repository.FlashcardRepository.class);
            var dictionary = mock(com.englishcoach.dictionary.repository.DictionaryRepository.class);
            var pool = new java.util.ArrayList<com.englishcoach.flashcard.entity.Flashcard>();
            String[] words = {"brave", "calm", "eager", "gentle", "honest", "jolly", "kind", "lively", "polite", "proud", "silent", "clever"};
            String[] meanings = {"dũng cảm", "bình tĩnh", "háo hức", "dịu dàng", "thật thà", "vui vẻ", "tử tế", "sống động", "lịch sự", "tự hào", "yên lặng", "thông minh"};
            for (int i=0;i<words.length;i++) {
                var entry = new com.englishcoach.dictionary.entity.DictionaryEntry();
                entry.setId(101L+i);entry.setWord(words[i]);entry.setGeneralTranslationVi(meanings[i]);entry.setMeanings(List.of(meanings[i]));
                var card = new com.englishcoach.flashcard.entity.Flashcard();card.setDictionaryEntry(entry);pool.add(card);
            }
            when(cards.findPvPPersonalWords(anyLong())).thenReturn(com.englishcoach.flashcard.pvp.PvPWordFixtures.rows(pool.stream().map(com.englishcoach.flashcard.entity.Flashcard::getDictionaryEntry).toList()));
            return new CardBlastPvPService(template,cards,dictionary,mock(com.englishcoach.flashcard.repository.VocabDeckRepository.class));
        }
        @Bean com.englishcoach.auth.repository.UserRepository users(){return mock(com.englishcoach.auth.repository.UserRepository.class);}
        @Bean com.englishcoach.user.service.UserProfileService profiles(){return mock(com.englishcoach.user.service.UserProfileService.class);}
        /** The bundled approved King lexicon (REVIEW_PREVIEW), as production reads its snapshot: Echo's levels are real here. */
        @Bean(destroyMethod="close") com.englishcoach.kingofenglish.KingCorpus king(){return new com.englishcoach.kingofenglish.KingCorpus("REVIEW_PREVIEW");}
        @Bean JwtDecoder decoder(){return token->{
            if(!Set.of("fixture-1","fixture-2","fixture-3").contains(token)) throw new JwtException("Test token rejected");
            return new Jwt(token,Instant.now(),Instant.now().plusSeconds(3600),Map.of("alg","test-only"),Map.of("sub",token.substring(8)));
        };}
        @Bean CustomJwtAuthenticationConverter converter(){
            var converter=mock(CustomJwtAuthenticationConverter.class);
            when(converter.convert(any(Jwt.class))).thenAnswer(inv->{
                Jwt jwt=inv.getArgument(0);Long id=Long.valueOf(jwt.getSubject());
                var user=new UserDetailsImpl(id,"fixture"+id+"@example.test","",List.of());
                return new UsernamePasswordAuthenticationToken(user,null,user.getAuthorities());
            });return converter;
        }
        @Bean SecurityFilterChain security(HttpSecurity http,CustomJwtAuthenticationConverter converter)throws Exception {
            return http.csrf(c->c.disable()).authorizeHttpRequests(a->a.requestMatchers("/ws-card-blast").permitAll().anyRequest().authenticated())
                .oauth2ResourceServer(o->o.jwt(j->j.jwtAuthenticationConverter(converter))).build();
        }
    }
    static class Peer implements AutoCloseable {
        final WebSocketStompClient client=new WebSocketStompClient(new StandardWebSocketClient());
        final BlockingQueue<Map<String,Object>> events=new LinkedBlockingQueue<>();
        StompSession session;
        Peer(int port,int user)throws Exception {
            this(port,user,"/user/queue/word-chain");
        }
        Peer(int port,int user,String queue)throws Exception {
            client.setMessageConverter(new MappingJackson2MessageConverter());
            var headers=new StompHeaders();headers.add("Authorization","Bearer fixture-"+user);
            session=client.connectAsync("ws://localhost:"+port+"/ws-card-blast",new org.springframework.web.socket.WebSocketHttpHeaders(),headers,new StompSessionHandlerAdapter(){}).get(10,TimeUnit.SECONDS);
            session.subscribe(queue,new StompFrameHandler(){
                public Type getPayloadType(StompHeaders h){return Map.class;}
                @SuppressWarnings("unchecked") public void handleFrame(StompHeaders h,Object p){events.offer((Map<String,Object>)p);}
            });
        }
        @SuppressWarnings("unchecked") Map<String,Object> command(String action,Map<String,Object> payload)throws Exception {
            String id=UUID.randomUUID().toString();var body=new HashMap<>(payload);body.put("messageId",id);
            session.send("/app/word-chain/"+action,body);
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(System.nanoTime()<end){var e=events.poll(1,TimeUnit.SECONDS);if(e!=null && id.equals(e.get("messageId"))) return e;}
            throw new AssertionError("No ACK for "+action);
        }
        public void close(){if(session!=null && session.isConnected())session.disconnect();client.stop();}
        Map<String,Object> cardBlast(String action, Map<String,Object> payload, String expected)throws Exception {
            session.send("/app/pvp/"+action,payload);
            long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
            while(System.nanoTime()<end){var e=events.poll(1,TimeUnit.SECONDS);if(e!=null && expected.equals(e.get("type"))) return e;}
            throw new AssertionError("No Card Blast "+expected+" for "+action);
        }
    }
    @Test @SuppressWarnings("unchecked") void cardBlastUsesPrincipalQueueAndIgnoresOtherSessionDisconnect()throws Exception {
        try(var context=(ServletWebServerApplicationContext)new SpringApplicationBuilder(Fixture.class)
            .properties("spring.config.location=optional:classpath:word-chain-test-empty.properties",
                "server.port=0","spring.main.banner-mode=off","logging.level.root=WARN").run()) {
            int port=context.getWebServer().getPort();
            try(var a=new Peer(port,1,"/user/queue/pvp");var b=new Peer(port,2,"/user/queue/pvp")) {
                long clickAt=System.nanoTime();
                var created=a.cardBlast("create",Map.of("mode","HUMAN","deckTitle","Fixture vocabulary"),"ROOM_CREATED");
                long latency=TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-clickAt);
                var state=(Map<String,Object>)created.get("payload");String code=(String)state.get("roomCode");
                assertTrue(latency<5000);System.out.println("CARD_BLAST_CREATE_ACK_MS="+latency);
                b.cardBlast("join",Map.of("roomCode",code),"ROOM_JOINED");
                var service=context.getBean(CardBlastPvPService.class);var room=service.getRoom(code);
                assertEquals("fixture1@example.test",room.getHost().getPrincipalName());
                assertEquals("1",room.getHost().getUserId());
                try(var notifications=new Peer(port,1)) { notifications.close(); }
                Thread.sleep(100);
                assertTrue(room.getHost().isConnected());
                service.setReady("1",code,true);service.setReady("2",code,true);
                room.setMatchStartServerMs(System.currentTimeMillis()-1);service.gameLoopTick();
                service.handleClientGameOver("1",code,"KO");assertEquals(com.englishcoach.flashcard.pvp.model.RoomStatus.IN_GAME,room.getStatus());
                b.close();
                Thread.sleep(100);
                try(var rejoined=new Peer(port,2,"/user/queue/pvp")) {
                    rejoined.cardBlast("rejoin",Map.of("roomCode",code),"ROOM_REJOINED");
                    assertTrue(room.getGuest().isConnected());assertNull(room.getGuest().getDisconnectDeadlineMs());
                    rejoined.cardBlast("leave",Map.of("roomCode",code),"ROOM_LEFT");
                    var result=a.events.poll(5,TimeUnit.SECONDS);
                    while(result!=null && !"MATCH_END".equals(result.get("type"))) result=a.events.poll(5,TimeUnit.SECONDS);
                    assertNotNull(result);assertEquals("FORFEIT",((Map<?,?>)result.get("payload")).get("reason"));
                    assertEquals(com.englishcoach.flashcard.pvp.model.RoomStatus.FINISHED,room.getStatus());
                }
            }
        }
    }
    @Test @SuppressWarnings("unchecked") void twoAuthenticatedClientsPlayAndRejoinThroughExistingBroker()throws Exception {
        boolean browser=Boolean.getBoolean("wordchain.browser");
        try(var context=(ServletWebServerApplicationContext)new SpringApplicationBuilder(Fixture.class)
            .properties("spring.config.location=optional:classpath:word-chain-test-empty.properties",
                "server.port="+(browser?18081:0),"CORS_ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002,http://localhost:3003",
                "spring.main.banner-mode=off","logging.level.root=WARN").run()) {
            int port=context.getWebServer().getPort();
            var service=context.getBean(WordChainService.class);var random=service.startLetter;service.startLetter=()->'o';
            try(var a=new Peer(port,1);var b=new Peer(port,2);var outsider=new Peer(port,3)) {
                var created=a.command("create",Map.of());assertEquals("ACK",created.get("type"));
                var state=(Map<String,Object>)created.get("state");String code=(String)state.get("roomCode");
                assertEquals("ACK",b.command("join",Map.of("roomCode",code)).get("type"));
                a.command("ready",Map.of("roomCode",code));
                state=(Map<String,Object>)b.command("ready",Map.of("roomCode",code)).get("state");assertEquals("ACTIVE",state.get("status"));
                var spoof=outsider.command("submit",Map.of("roomCode",code,"word","orange","revision",state.get("revision"),"userId",1));
                assertEquals("NOT_A_MEMBER",spoof.get("code"));
                var accepted=a.command("submit",Map.of("roomCode",code,"word","orange","revision",state.get("revision")));
                state=(Map<String,Object>)accepted.get("state");assertEquals("ACK",accepted.get("type"));assertEquals("e",state.get("requiredLetter"));
                var invalid=b.command("submit",Map.of("roomCode",code,"word","yellow","revision",state.get("revision")));
                assertEquals("WRONG_LETTER",invalid.get("code"));
                b.close();
                try(var rejoined=new Peer(port,2)) {
                    state=(Map<String,Object>)rejoined.command("rejoin",Map.of("roomCode",code)).get("state");
                    assertEquals(1,((List<?>)state.get("moves")).size());
                    assertEquals("ACK",rejoined.command("submit",Map.of("roomCode",code,"word","energy","revision",state.get("revision"))).get("type"));
                    var end=(Map<String,Object>)a.command("give-up",Map.of("roomCode",code)).get("state");assertEquals("FINISHED",end.get("status"));
                    // The result is written off the room lock; the saved state is pushed when the write commits.
                    long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
                    while(!Boolean.TRUE.equals(end.get("resultSaved")) && System.nanoTime()<until) {
                        var e=a.events.poll(1,TimeUnit.SECONDS);
                        if(e!=null && "STATE".equals(e.get("type"))) end=(Map<String,Object>)e.get("state");
                    }
                    assertEquals(true,end.get("resultSaved"));
                    assertEquals(1,context.getBean(WordChainResults.class).history(1).size());
                    assertEquals(1,context.getBean(WordChainResults.class).history(2).size());
                    assertTrue(context.getBean(WordChainResults.class).history(3).isEmpty());
                    a.command("rematch",Map.of("roomCode",code));
                    assertEquals("ACTIVE",((Map<?,?>)rejoined.command("rematch",Map.of("roomCode",code)).get("state")).get("status"));
                    a.command("give-up",Map.of("roomCode",code));a.command("leave",Map.of("roomCode",code));rejoined.command("leave",Map.of("roomCode",code));
                }
            }
            if(browser){service.startLetter=random;System.out.println("WORD_CHAIN_BROWSER_FIXTURE_READY port="+port);Thread.sleep(Long.getLong("wordchain.fixture.ms",900000L));}
        }
    }
}
