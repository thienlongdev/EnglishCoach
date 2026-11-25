package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.servlet.context.ServletWebServerApplicationContext;
import java.util.*;
import static com.englishcoach.kingofenglish.KingRealtimeTest.*;
import static org.junit.jupiter.api.Assertions.*;

class KingCorpusPreviewRealtimeTest {
    @Test void allSixteenPreviewFlowsUsePackagedCorpusAndPrivateProjections()throws Exception{
        try(var app=(ServletWebServerApplicationContext)new SpringApplicationBuilder(Fixture.class).properties(
            "spring.config.location=optional:classpath:king-fixture-empty.properties","server.port=0",
            "king.content-channel=REVIEW_PREVIEW","spring.main.banner-mode=off","logging.level.root=WARN").run()){
            assertFalse(app.containsBean("dataSource"));int port=app.getWebServer().getPort();
            for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST"))for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
                try(var a=new Peer(port,1);var b=new Peer(port,2)){
                    boolean human=Set.of("QUICK_MATCH","PRIVATE_ROOM").contains(flow);
                    var s=state(a.command(flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start",Map.of("mode",mode,"flow",flow,"contentChannel","ENGINEERING")));
                    String code=(String)s.get("roomCode");
                    if(human){state(b.command(flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?Map.of("mode",mode):Map.of("roomCode",code)));state(a.command("ready",Map.of("roomCode",code)));state(b.command("ready",Map.of("roomCode",code)));}
                    s=state(a.command("ping",Map.of("roomCode",code)));assertEquals("REVIEW_PREVIEW",s.get("contentChannel"));assertEquals("PLAYING",s.get("status"));
                    String payload=new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(s);
                    assertFalse(payload.contains("acceptedAliases"));assertFalse(payload.contains("semanticLinks"));assertFalse(payload.contains("echoCandidates"));
                    if(Set.of("REORDER","REFLEX").contains(mode)){
                        @SuppressWarnings("unchecked") var challenge=(Map<String,Object>)s.get("challenge");assertTrue(((String)challenge.get("id")).startsWith("kc-"));assertFalse(challenge.containsKey("answer"));
                        if(human){var guest=state(b.command("ping",Map.of("roomCode",code)));assertEquals(challenge,guest.get("challenge"));}
                    }
                    state(a.command("leave",Map.of("roomCode",code)));
                    if(human)state(b.command("leave",Map.of("roomCode",code)));
                }
            }
        }
    }
}
