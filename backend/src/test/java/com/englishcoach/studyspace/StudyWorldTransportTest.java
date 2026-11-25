package com.englishcoach.studyspace;

import com.englishcoach.common.security.*;
import com.englishcoach.flashcard.pvp.config.WebSocketConfig;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.speaking.arena.ArenaUsage;
import com.englishcoach.speaking.arena.ArenaVoice;
import java.lang.reflect.Type;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.messaging.converter.MappingJackson2MessageConverter;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.*;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Independent WebSockets on a loopback Spring broker. Only test identities and the name lookup are fixtures. */
class StudyWorldTransportTest {
    @TestConfiguration
    @EnableAutoConfiguration(exclude={org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration.class,
            org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration.class,
            org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration.class,
            org.springframework.boot.autoconfigure.data.jpa.JpaRepositoriesAutoConfiguration.class})
    @Import({WebSocketConfig.class, StompAuthChannelInterceptor.class, StudySharedService.class, StudyWorldSocket.class})
    static class Broker {
        @Bean org.springframework.security.web.SecurityFilterChain security(
                org.springframework.security.config.annotation.web.builders.HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(requests -> requests.requestMatchers("/ws-card-blast").permitAll()
                    .anyRequest().authenticated()).build();
        }
        @Bean CardBlastPvPService pvp() { return mock(CardBlastPvPService.class); }
        @Bean ArenaVoice voice() { return mock(ArenaVoice.class); }
        @Bean ArenaUsage usage() { return mock(ArenaUsage.class); }
        @Bean JdbcTemplate names() {
            var jdbc = mock(JdbcTemplate.class);
            when(jdbc.queryForObject(anyString(),eq(String.class),anyLong())).thenAnswer(i -> "Learner " + i.getArgument(2));
            return jdbc;
        }
        @Bean JwtDecoder decoder() {
            return value -> {
                if (!Set.of("study-fixture-a","study-fixture-b").contains(value)) throw new JwtException("Unknown fixture");
                return new Jwt(value, Instant.now(), Instant.now().plusSeconds(300), Map.of("alg","test"),
                        Map.of("sub",value.endsWith("-a") ? "1" : "2"));
            };
        }
        @Bean CustomJwtAuthenticationConverter identity() {
            var converter = mock(CustomJwtAuthenticationConverter.class);
            when(converter.convert(any())).thenAnswer(i -> {
                Jwt jwt = i.getArgument(0);
                var user = new UserDetailsImpl(Long.parseLong(jwt.getSubject()), "learner"+jwt.getSubject()+"@example.test",
                        "", List.of());
                return new UsernamePasswordAuthenticationToken(user,null,user.getAuthorities());
            });
            return converter;
        }
    }
    static class Learner implements AutoCloseable {
        private final WebSocketStompClient client = new WebSocketStompClient(new StandardWebSocketClient());
        private final StompSession socket;
        private final BlockingQueue<StudyWorldPresence.Frame> frames = new LinkedBlockingQueue<>();
        private long seq;
        Learner(int port,String token) throws Exception {
            client.setMessageConverter(new MappingJackson2MessageConverter());
            var headers = new StompHeaders();
            headers.add("Authorization","Bearer " + token);
            socket = client.connectAsync("ws://127.0.0.1:"+port+"/ws-card-blast",new WebSocketHttpHeaders(),
                    headers,new StompSessionHandlerAdapter(){}).get(8,TimeUnit.SECONDS);
            socket.subscribe("/user/queue/echo-life",new StompFrameHandler() {
                public Type getPayloadType(StompHeaders h) { return StudyWorldPresence.Frame.class; }
                public void handleFrame(StompHeaders h,Object p) { frames.offer((StudyWorldPresence.Frame)p); }
            });
        }
        StudyWorldPresence.Frame frame(UUID room,StudyWorldPresence.Pose pose,String emote) throws Exception {
            return frame(room,pose,emote,null);
        }
        StudyWorldPresence.Frame frame(UUID room,StudyWorldPresence.Pose pose,String emote,StudyWorldEquipment.Intent intent) throws Exception {
            return frame(room,pose,emote,intent,null);
        }
        StudyWorldPresence.Frame frame(UUID room,StudyWorldPresence.Pose pose,String emote,StudyWorldEquipment.Intent intent,
                                       StudyWorldEvent.Intent event) throws Exception {
            // As in the browser, send at 5 Hz. This also tolerates the first subscription arriving after the first frame.
            long limit = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            while (System.nanoTime() < limit) {
                long sent = ++seq;
                socket.send("/app/echo-life/presence",new StudyWorldPresence.Input(room,sent,pose,emote,intent,null,event));
                var reply = frames.poll(200,TimeUnit.MILLISECONDS);
                if (reply != null && reply.seq() == sent) return reply;
            }
            throw new AssertionError("Private STOMP response timed out");
        }
        public void close() { if (socket.isConnected()) socket.disconnect(); client.stop(); }
    }

    @Test void twoLearnersMeetMoveWaveLeaveAndReconnect() throws Exception {
        try (var app = (ServletWebServerApplicationContext)new SpringApplicationBuilder(Broker.class).properties(
                "spring.config.location=optional:classpath:study-world-test-empty.properties",
                "server.address=127.0.0.1","server.port=0","app.echo-life.shared-world=true",
                "spring.main.banner-mode=off","logging.level.root=WARN").run()) {
            var rooms = app.getBean(StudySharedService.class);
            var created = rooms.create(1,"City walk",2);
            assertTrue(rooms.join(2,created.invite()).worldAvailable());
            UUID room = created.room().id();
            var park = new StudyWorldPresence.Pose("park",1,0,2,.2,"LYRA");
            var moved = new StudyWorldPresence.Pose("park",2,0,3,.6,"LYRA");
            var cafe = new StudyWorldPresence.Pose("cafe",0,0,0,0,"KAI");
            int port = app.getWebServer().getPort();
            try (var a = new Learner(port,"study-fixture-a")) {
                a.frame(room,park,null);
                try (var b = new Learner(port,"study-fixture-b")) {
                    assertEquals(1,b.frame(room,park,null).peers().get(0).id());
                    assertEquals(2,a.frame(room,moved,"wave").peers().get(0).id());
                    var observed = b.frame(room,park,null).peers().get(0);
                    assertEquals(moved,observed.pose());
                    assertEquals("wave",observed.emote());
                    var bike=b.frame(room,park,null).equipment().get(0);
                    var borrow=new StudyWorldEquipment.Intent("claim",bike.id(),bike.revision());
                    var taken=b.frame(room,park,null,borrow);
                    assertEquals("CLAIMED",taken.actionResult());
                    assertEquals(2L,taken.equipment().get(0).holder());
                    assertEquals("STALE_EQUIPMENT",a.frame(room,park,null,borrow).actionResult());
                    var held=a.frame(room,park,null).equipment().get(0);
                    assertEquals(2L,held.holder());
                    assertEquals("IN_USE",a.frame(room,park,null,new StudyWorldEquipment.Intent("claim","bike",held.revision())).actionResult());
                    var event=rooms.inviteToEvent(1,room,"evt_park",()->Optional.of(
                            new com.englishcoach.echolife.EchoLifeGameService.EventWindow("evt_park","park","Park gathering",60_000)));
                    var join=new StudyWorldEvent.Intent(event.invitation(),"join");
                    var ready=new StudyWorldEvent.Intent(event.invitation(),"ready");
                    assertTrue(a.frame(room,park,null,null,ready).event().readySelf());
                    assertTrue(b.frame(room,park,null,null,join).event().joined());
                    assertEquals(2,b.frame(room,park,null,null,ready).event().ready());
                    assertTrue(b.frame(room,cafe,null).peers().isEmpty());
                    assertTrue(a.frame(room,park,null).peers().isEmpty());
                    assertNull(a.frame(room,park,null).equipment().get(0).holder());
                    assertEquals(1,a.frame(room,park,null).event().ready());
                }
                try (var rejoined = new Learner(port,"study-fixture-b")) {
                    var recovered=rejoined.frame(room,park,null);
                    assertEquals(1,recovered.peers().get(0).id());
                    assertTrue(recovered.event().joined());
                    assertFalse(recovered.event().readySelf());
                    var invitation=recovered.event().invitation();
                    var ready=new StudyWorldEvent.Intent(invitation,"ready");
                    assertEquals(2,rejoined.frame(room,park,null,null,ready).event().ready());
                    long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(8);
                    while (!a.frame(room,park,null).event().celebrated()) {
                        assertTrue(System.nanoTime()<deadline,"cooperative celebration timed out");
                        rejoined.frame(room,park,null);
                    }
                    assertTrue(rejoined.frame(room,park,null).event().celebrated());
                    assertNull(a.frame(room,park,null,null,new StudyWorldEvent.Intent(invitation,"end")).event());
                    assertEquals(2,a.frame(room,park,null).peers().get(0).id());
                    rooms.leave(2,room);
                    assertTrue(a.frame(room,park,null).peers().isEmpty());
                }
            }
        }
    }
}
