package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.learningpath.LearningPathDtos;
import com.englishcoach.learningpath.LearningPathException;
import com.englishcoach.learningpath.LearningPathService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * PREPARE only: asks {@link LearningPathService#propose} to compute a deterministic Learner DNA curriculum adjustment
 * proposal for this learner and issues a single-use {@link EchoConfirmations} token. Nothing mutates the active plan
 * until the learner explicitly confirms.
 */
@Component
public class DnaPlanUpdateTool implements EchoTool {
    private final ObjectProvider<LearningPathService> learningPath;
    private final EchoConfirmations confirmations;
    private final ObjectMapper mapper;

    public DnaPlanUpdateTool(ObjectProvider<LearningPathService> learningPath,
                             EchoConfirmations confirmations,
                             ObjectMapper mapper) {
        this.learningPath = learningPath;
        this.confirmations = confirmations;
        this.mapper = mapper;
    }

    @Override public String name() { return "prepare_dna_plan_update"; }
    @Override public String description() {
        return "Prepare (not apply) a Learning Path focus adjustment based on this learner's 7-day Learner DNA signals "
                + "(pronunciation, grammar errors, listening traps, due flashcards). Shows a Confirm / Cancel preview card; "
                + "say it is prepared and awaits their confirmation, never that it is already applied.";
    }
    @Override public Map<String, Object> parameters() {
        return EchoToolRegistry.schema(Map.of(), List.of());
    }
    @Override public Kind kind() { return Kind.PREPARE; }
    @Override public boolean readOnlyTransaction() { return false; } // LearningPathService.propose manages its own tx
    @Override public String status(boolean vi) {
        return vi ? "Echo đang phân tích tín hiệu học tập để đề xuất điều chỉnh lộ trình…"
                : "Echo is preparing a Learner DNA plan proposal for your confirmation…";
    }

    @Override
    public String run(EchoTurn turn, JsonNode args) throws Exception {
        if (!com.englishcoach.ai.echo.camel.CaMeLPolicyEngine.canPreparePlanChange(turn)) {
            return mapper.writeValueAsString(Map.of("prepared", false, "reason", "not_authorized_by_learner"));
        }
        LearningPathService svc = learningPath.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";
        LearningPathDtos.ProposalView proposal;
        try {
            proposal = svc.propose(turn.userId());
        } catch (LearningPathException ex) {
            String code = ex.getMessage() == null ? "unavailable" : ex.getMessage().toLowerCase(Locale.ROOT);
            return mapper.writeValueAsString(Map.of(
                    "prepared", false,
                    "reason", code));
        }
        if (proposal.changes() == null || proposal.changes().isEmpty()) {
            return mapper.writeValueAsString(Map.of("prepared", false, "reason", "no_focus_changes_needed"));
        }
        String token = confirmations.issue(turn.userId(), new EchoConfirmations.DnaProposalCommit(proposal.id()));
        List<EchoCard.Item> rows = new ArrayList<>();
        ObjectNode out = mapper.createObjectNode()
                .put("prepared", true)
                .put("requiresLearnerConfirmation", true)
                .put("proposalId", proposal.id());
        ArrayNode changes = out.putArray("changes");
        for (LearningPathDtos.ChangeView c : proposal.changes()) {
            changes.addObject()
                    .put("skill", c.skill())
                    .put("direction", c.direction())
                    .put("reason", c.reason() == null ? "" : c.reason());
            if (rows.size() < 5) {
                String dir = "UP".equalsIgnoreCase(c.direction())
                        ? turn.t("Tăng ưu tiên", "Increase focus")
                        : turn.t("Giữ ổn định", "Rebalance");
                rows.add(new EchoCard.Item(c.skill(), dir, c.reason() == null ? "" : c.reason(), null, null));
            }
        }
        turn.card(new EchoCard(
                "confirm",
                turn.t("Đề xuất cập nhật lộ trình từ tín hiệu luyện tập", "Proposed Learning Path focus update"),
                rows,
                token,
                turn.t("Nhiệm vụ hôm nay giữ nguyên; điều chỉnh chỉ áp dụng khi bạn bấm Xác nhận.",
                        "Today's tasks stay unchanged; the focus update applies only after you confirm.")));
        return out.toString();
    }
}
