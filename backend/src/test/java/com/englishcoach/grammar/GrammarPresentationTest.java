package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

class GrammarPresentationTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final GrammarContent content = new GrammarContent(mapper);
    private final GrammarEvaluator evaluator = new GrammarEvaluator(mapper);

    @Test
    void sourceOptionPermutationAndCorrectnessMetadataCannotChangePresentationIds() throws Exception {
        JsonNode authored = mapper.readTree("""
                {"id":"hidden-choice","type":"choice","options":[
                  {"t":"was","ok":true,"note":"originally first"},
                  {"t":"is","ok":false},{"t":"are","ok":false}]}
                """);
        ObjectNode reordered = authored.deepCopy();
        var options = reordered.putArray("options");
        options.add(authored.path("options").get(2)).add(authored.path("options").get(0)).add(authored.path("options").get(1));
        JsonNode key = GrammarContent.presentationExercise(authored);
        assertThat(content.learnerExercise(key)).isEqualTo(content.learnerExercise(GrammarContent.presentationExercise(reordered)));
        ObjectNode changedKey = key.deepCopy();
        for (JsonNode option : changedKey.path("options")) ((ObjectNode) option).put("ok", !option.path("ok").asBoolean());
        assertThat(content.learnerExercise(key)).isEqualTo(content.learnerExercise(changedKey));
        for (JsonNode shown : content.learnerExercise(key).path("options")) {
            var verdict = evaluator.evaluate(key, mapper.createObjectNode().put("choice", shown.path("i").asInt()));
            assertThat(verdict.outcome()).isEqualTo("was".equals(shown.path("t").asText()) ? "CORRECT" : "WRONG");
        }
        assertThat(key.path("options").get(0).path("ok").asBoolean()).isFalse();
    }

    @Test
    void publicMatchingShuffleCannotRecoverAuthorAlignedRightColumn() throws Exception {
        JsonNode first = mapper.readTree("""
                {"id":"hidden-match","type":"match","pairs":[{"a":"one","b":"Zulu"},{"a":"two","b":"Alpha"},{"a":"three","b":"Mike"}]}
                """);
        ObjectNode differentAnswers = first.deepCopy();
        ((ObjectNode) differentAnswers.path("pairs").get(0)).put("b", "Alpha");
        ((ObjectNode) differentAnswers.path("pairs").get(1)).put("b", "Zulu");
        assertThat(content.learnerExercise(first)).isEqualTo(content.learnerExercise(differentAnswers));
    }

    @Test
    void tokenBankDoesNotDependOnAuthoredOrderOrAcceptableSequences() throws Exception {
        JsonNode first = mapper.readTree("""
                {"id":"hidden-order","type":"order","tokens":["I","can","swim"],"accept":[["I","can","swim"]]}
                """);
        ObjectNode another = first.deepCopy();
        another.putArray("tokens").add("swim").add("I").add("can");
        another.set("accept", mapper.valueToTree(List.of(List.of("swim", "can", "I"))));
        assertThat(content.learnerExercise(first)).isEqualTo(content.learnerExercise(another));
    }

    @Test
    void heldOutChoiceIndicesNoLongerEncodeAuthorsCorrectFirstConventionAndSurviveReload() {
        int total = 0, firstCorrect = 0;
        for (var meta : content.topics()) if (meta.available()) {
            for (JsonNode ex : content.load(meta.slug()).exercises().values()) {
                if (!"choice".equals(ex.path("type").asText()) || !"check".equals(ex.path("use").asText())) continue;
                total++;
                if (ex.path("options").get(0).path("ok").asBoolean()) firstCorrect++;
                for (JsonNode shown : content.learnerExercise(ex).path("options")) {
                    int id = shown.path("i").asInt();
                    assertThat(evaluator.evaluate(ex, mapper.createObjectNode().put("choice", id)).score())
                            .isEqualTo(ex.path("options").get(id).path("ok").asBoolean() ? 1.0 : 0.0);
                }
            }
        }
        assertThat(total).isGreaterThan(200);
        assertThat(firstCorrect).isLessThan(total * 7 / 10);
        assertThat(new GrammarContent(mapper).load("verb-be").learnerJson()).isEqualTo(content.load("verb-be").learnerJson());
    }
}
