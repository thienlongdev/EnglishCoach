package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

/** Opt-in real Cloud control-plane canary. No browser, microphone or acoustic claims. */
@EnabledIfEnvironmentVariable(named = "SPEAKING_ARENA_LIVE_TEST", matches = "1")
class LiveKitArenaVoiceIntegrationTest {
    @Test void cloudRoomAndAbsentParticipantRevocation() {
        var voice = new LiveKitArenaVoice(true, System.getenv("LIVEKIT_URL"),
                System.getenv("LIVEKIT_API_KEY"), System.getenv("LIVEKIT_API_SECRET"), new ObjectMapper());
        assertTrue(voice.available());
        String room = "ec-arena-canary-" + UUID.randomUUID();
        try {
            voice.create(room, 2);
            assertEquals(java.util.Map.of(), voice.participants(room), "a clean empty answer, never null: settlement must tell nobody-there from no-answer");
            assertFalse(voice.token(room, "canary-absent", true).isBlank());
            voice.remove(room, "canary-absent");
            voice.remove(room, "canary-absent");
        } finally { voice.close(room); }
        voice.close(room);
    }
}
