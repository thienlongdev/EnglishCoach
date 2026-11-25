package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.echo.*;
import com.englishcoach.writing.repository.*;
import com.englishcoach.writing.enums.IssueDisposition;
import org.springframework.data.domain.PageRequest;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import java.util.*;

@Component
public class WritingFeedbackTool implements EchoTool {
    private final WritingErrorMemoryRepository memory;
    private final ObjectMapper mapper;
    private final WritingAssessmentRepository assessments;
    private final WritingFeedbackIssueRepository issues;
    public WritingFeedbackTool(WritingErrorMemoryRepository memory, ObjectMapper mapper,
                               WritingAssessmentRepository assessments, WritingFeedbackIssueRepository issues) {
        this.assessments = assessments; this.issues = issues;
        this.memory = memory; this.mapper = mapper;
    }
    public String name() { return "get_writing_feedback"; }
    public String description() { return "Read the latest ready submission’s active feedback categories and up to three recurring writing error patterns for this learner. Explain them with original examples. Essay text is unavailable."; }
    public Kind kind() { return Kind.READ; }
    public Map<String,Object> parameters() { return EchoToolRegistry.schema(Map.of(),List.of()); }
    public String status(boolean vi) { return vi ? "Echo đang xem phản hồi bài viết…" : "Echo is checking your writing feedback…"; }
    public String run(EchoTurn turn, JsonNode args) {
        var result = mapper.createObjectNode();
        var patterns = result.putArray("assessedPatterns");
        for (var row : memory.findTop3ByUserIdAndIsMutedFalseOrderByLastSeenAtDesc(turn.userId())) {
            String code = row.getPatternCode();
            if (code == null || !code.matches("[a-zA-Z0-9_.-]{1,96}")) continue;
            patterns.addObject().put("pattern",code).put("occurrences",row.getOccurrenceCount())
                    .put("contexts",row.getContextCount()).put("sufficientEvidence",row.getHasSufficientEvidence())
                    .put("dueForPractice",row.getDueForPractice());
        }
        var ready = assessments.latestReadyForOwner(turn.userId(),PageRequest.of(0,1));
        result.put("hasReadySubmission",!ready.isEmpty());
        var feedback = result.putArray("latestActiveFeedback");
        if (!ready.isEmpty()) {
            for (var issue : issues.findTop2ByAssessmentIdAndDispositionOrderByPriorityRankAsc(ready.getFirst(),IssueDisposition.ACTIVE)) {
                var item = feedback.addObject().put("kind",issue.getKind().name()).put("severity",issue.getSeverity().name());
                if (issue.getPatternCode() != null && issue.getPatternCode().matches("[a-zA-Z0-9_.-]{1,96}"))
                    item.put("pattern",issue.getPatternCode());
                if (issue.getCategory() != null && issue.getCategory().matches("[a-zA-Z0-9_ -]{1,64}"))
                    item.put("category",issue.getCategory());
            }
        }
        return result.toString();
    }
}
