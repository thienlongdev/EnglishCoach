package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.echo.EchoMemoryService;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Remembers one thing the learner explicitly asked Echo to remember. The service refuses unless the learner's own latest
 * words carry a memory cue, so neither a retrieved text nor the model alone can write memory. Never evidence of ability.
 */
@Component
public class MemoryTool implements EchoTool {
    private final EchoMemoryService memory;
    private final EchoLearnerBrain brain;
    private final ObjectMapper mapper;

    public MemoryTool(EchoMemoryService memory, EchoLearnerBrain brain, ObjectMapper mapper) {
        this.memory = memory; this.brain = brain; this.mapper = mapper;
    }

    public String name() { return "remember_learner_note"; }
    public String description() {
        return "Save ONE preference or note the learner explicitly asked you to remember (e.g. 'remember I prefer short answers', "
                + "'correct everything I say from now on', 'nhớ là mình đang ôn IELTS 7.0'). kinds: EXPLANATION_LANGUAGE, ANSWER_STYLE, "
                + "LEVEL_PREFERENCE, FOCUS_SKILL, STATED_GOAL, COACHING_MODE, INTEREST, NOTE. Do not call it for anything the learner "
                + "did not ask you to remember. It is never a measured level.";
    }
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("kind", EchoToolRegistry.enumOf("What kind of note", EchoMemoryService.KINDS));
        props.put("text", EchoToolRegistry.str("The note in the learner's own terms, one short line", EchoMemoryService.MAX_VALUE));
        return EchoToolRegistry.schema(props, List.of("kind", "text"));
    }
    public Kind kind() { return Kind.MEMORY; }
    public boolean readOnlyTransaction() { return false; }
    public String status(boolean vi) { return vi ? "Echo đang ghi nhớ…" : "Echo is remembering…"; }

    public String run(EchoTurn turn, JsonNode args) throws Exception {
        if (!com.englishcoach.ai.echo.camel.CaMeLPolicyEngine.canWriteMemory(turn)) {
            return mapper.writeValueAsString(Map.of("stored", false, "reason", "the learner did not ask to remember this, or the note is not allowed"));
        }
        var stored = memory.remember(turn.userId(), turn.userText(), args.path("kind").asText(), args.path("text").asText());
        if (stored.isEmpty())
            return mapper.writeValueAsString(Map.of("stored", false, "reason", "the learner did not ask to remember this, or the note is not allowed"));
        brain.forget(turn.userId());
        turn.card(EchoCard.of("memory", turn.t("Echo đã ghi nhớ", "Echo will remember"),
                List.of(new EchoCard.Item(stored.get(), null, null, null, null)),
                turn.t("Bạn xem hoặc xóa trong Tùy chọn Echo → Echo ghi nhớ.", "View or delete it in Echo options → Echo remembers.")));
        return mapper.writeValueAsString(Map.of("stored", true));
    }
}
