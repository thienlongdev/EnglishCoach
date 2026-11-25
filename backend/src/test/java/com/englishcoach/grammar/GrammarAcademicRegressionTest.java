package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.assertj.core.api.Assertions.assertThat;

class GrammarAcademicRegressionTest {
    final ObjectMapper mapper = new ObjectMapper();
    final GrammarContent content = new GrammarContent(mapper);
    final GrammarEvaluator evaluator = new GrammarEvaluator(mapper);

    @Test
    void attestedAccuratenessIsAnAcceptableAlternativeNotWrong() {
        var answer = mapper.createObjectNode(); answer.putObject("blanks").put("1", "accurateness");
        var verdict = evaluator.evaluate(content.exercise("nominalization-10"), answer);
        assertThat(verdict.outcome()).isEqualTo("ACCEPTABLE");
        assertThat(verdict.score()).isEqualTo(1.0);
        assertThat(verdict.reveal().path("parts").get(0).path("note").asText()).contains("accuracy");
    }

    @Test
    void standardPastTenseTiredIsNotPresentedAsAnUnconditionallyWrongSentence() {
        var ex = content.exercise("vbe-13");
        for (var option : ex.path("options")) {
            assertThat("She tired.".equals(option.path("t").asText()) && !option.path("ok").asBoolean())
                    .as("tire can be an intransitive verb; replace an ambiguous distractor instead of penalising that reading").isFalse();
        }
    }

    @Test
    void advancedNounMasteryRequiresAFullMeaningPreservingConstruction() {
        for (String slug : List.of("nominalization", "complex-noun-phrases")) {
            var production = content.load(slug).exercises().values().stream().filter(e -> "check".equals(e.path("use").asText())
                    && List.of("cloze", "transform", "order").contains(e.path("type").asText())).toList();
            assertThat(production).hasSize(1);
            var ex = production.get(0);
            assertThat(ex.path("type").asText()).isEqualTo("transform");
            for (var accepted : ex.path("accept")) {
                assertThat(accepted.asText().split(" ").length).isGreaterThan(7);
                assertThat(evaluator.evaluate(ex, mapper.createObjectNode().put("text", accepted.asText())).outcome()).isEqualTo("CORRECT");
            }
            for (var wrong : ex.path("known")) {
                assertThat(evaluator.evaluate(ex, mapper.createObjectNode().put("text", wrong.path("t").asText())).outcome()).isEqualTo("WRONG");
                assertThat(wrong.path("note").asText()).contains("ngữ pháp");
            }
        }
    }
}
