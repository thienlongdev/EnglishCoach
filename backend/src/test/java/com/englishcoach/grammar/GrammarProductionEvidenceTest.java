package com.englishcoach.grammar;

import com.englishcoach.grammar.GrammarContent.TopicMeta;
import com.englishcoach.grammar.GrammarDtos.*;
import com.englishcoach.grammar.GrammarRepository.*;
import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

/** The production gate is an explicit instructional heuristic, not a proficiency calibration. */
class GrammarProductionEvidenceTest {
    final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());
    final GrammarContent content = mock(GrammarContent.class);
    final GrammarRepository repo = mock(GrammarRepository.class);
    final GrammarService service = new GrammarService(content, repo, mock(LearningEventService.class), mapper);

    CheckResult submit(String level, String production, boolean includeProduction) throws Exception {
        String slug = "qa-production"; long user = 100;
        when(content.meta(slug)).thenReturn(Optional.of(new TopicMeta(slug,"test","grammar",1,level,"grammar",true,List.of(),0,6,false,false,slug,"advanced")));
        List<CheckItem> items = new ArrayList<>(); Map<String,JsonNode> answers = new LinkedHashMap<>();
        for(int i=0;i<5;i++) {
            ObjectNode ex=(ObjectNode)mapper.readTree("""
              {"type":"choice","use":"check","skill":"recognition","level":"B1","options":[{"t":"right","ok":true,"note":"Known"},{"t":"wrong","note":"Known error"}],"explain":"Recognition evidence"}
              """);
            ex.put("id","qa-rec-"+i).put("_academyLevel",level);
            items.add(new CheckItem(slug,1,ex));answers.put(ex.path("id").asText(),mapper.createObjectNode().put("choice",0));
        }
        if(includeProduction) {
            ObjectNode ex=(ObjectNode)mapper.readTree("""
              {"id":"qa-production","type":"transform","use":"check","skill":"production","level":"B1",
               "accept":["The manager has already left."],"model":"The manager has already left.",
               "known":[{"t":"The manager have left.","verdict":"wrong","note":"Agreement error"}],"explain":"Construct the requested sentence"}
              """);
            ex.put("_academyLevel",level);items.add(new CheckItem(slug,1,ex));
            if(production!=null) answers.put("qa-production",mapper.createObjectNode().put("text",production));
        }
        UUID id=UUID.randomUUID();
        when(repo.session(id,user,true)).thenReturn(Optional.of(new Session(id,user,"TOPIC",slug,
                items.stream().map(i->i.exercise().path("id").asText()).toList(),items,Instant.now(),null,null,null,null)));
        return service.submit(user,id,new CheckSubmit(answers));
    }

    @Test void unrecognisedValidAlternativeDoesNotBecomeWrongOrAwardAdvancedMastery() throws Exception {
        var result=submit("B1","The manager has left already.",true);
        assertThat(result.pct()).isEqualTo(100);
        assertThat(result.scoredItems()).isEqualTo(5);
        assertThat(result.items().getLast().outcome()).isEqualTo("UNRECOGNIZED");
        assertThat(result.productionScored()).isZero();
        assertThat(result.productionRequired()).isEqualTo(1);
        assertThat(result.enoughEvidence()).isFalse();
        assertThat(result.mastery()).isEqualTo("INSUFFICIENT");
    }

    @Test void aScoredWrongConstructionCannotBeHiddenByHighRecognitionScore() throws Exception {
        var result=submit("B2","The manager have left.",true);
        assertThat(result.pct()).isEqualTo(83);
        assertThat(result.productionScored()).isEqualTo(1);
        assertThat(result.productionCorrect()).isZero();
        assertThat(result.enoughEvidence()).isTrue();
        assertThat(result.mastery()).isEqualTo("NOT_YET");
    }

    @Test void recognisedConstructionAndEnoughOtherEvidenceCanAwardMastery() throws Exception {
        var result=submit("B1","The manager has already left.",true);
        assertThat(result.productionCorrect()).isEqualTo(1);
        assertThat(result.enoughEvidence()).isTrue();
        assertThat(result.mastery()).isEqualTo("MASTERED");
    }

    @Test void unansweredOrAbsentProductionDoesNotAwardAdvancedMastery() throws Exception {
        assertThat(submit("C1",null,true).mastery()).isEqualTo("INSUFFICIENT");
        assertThat(submit("B1",null,false).mastery()).isEqualTo("INSUFFICIENT");
    }

    @Test void basicTopicPolicyIsNotSilentlyChanged() throws Exception {
        var result=submit("A1",null,false);
        assertThat(result.productionRequired()).isZero();
        assertThat(result.mastery()).isEqualTo("MASTERED");
    }
}
