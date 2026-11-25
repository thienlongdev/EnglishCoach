package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.*;

class GrammarEvaluatorTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final GrammarEvaluator evaluator = new GrammarEvaluator(mapper);

    private GrammarEvaluator.Verdict judge(String exercise, String answer) throws Exception {
        return evaluator.evaluate(mapper.readTree(exercise), mapper.readTree(answer));
    }

    @Test
    void normalizationDoesNotEraseTheGrammarBeingTested() throws Exception {
        String exercise = """
                {"type":"transform","accept":["They will not return"],
                 "known":[{"t":"They willn't return","verdict":"wrong","note":"Invalid contraction"}]}
                """;
        assertThat(judge(exercise, "{\"text\":\"They willn't return\"}").outcome()).isEqualTo("WRONG");
        assertThat(judge(exercise, "{\"text\":\"They won't return\"}").outcome()).isEqualTo("UNRECOGNIZED");
        assertThat(judge(exercise, "{\"text\":\"  THEY  will not return?! \"}").outcome()).isEqualTo("CORRECT");
        assertThat(judge("{\"type\":\"transform\",\"accept\":[\"I've eaten\"]}", "{\"text\":\"I’ve eaten.\"}").outcome()).isEqualTo("CORRECT");
        assertThat(judge("{\"type\":\"transform\",\"caseMatters\":true,\"accept\":[\"I\"]}", "{\"text\":\"i\"}").outcome()).isEqualTo("UNRECOGNIZED");
        assertThat(judge("{\"type\":\"transform\",\"accept\":[\"it's\"]}", "{\"text\":\"its\"}").outcome()).isEqualTo("UNRECOGNIZED");
    }

    @Test
    void anyUnknownBlankMakesTheWholeItemUnscoredEvenAlongsideAKnownError() throws Exception {
        var result = judge("""
                {"type":"cloze","blanks":{"1":{"accept":["is"],"closed":true},"2":{"accept":["working"]}}}
                """, "{\"blanks\":{\"1\":\"are\",\"2\":\"resting\"}}");
        assertThat(result.outcome()).isEqualTo("UNRECOGNIZED");
        assertThat(result.score()).isNull();
        assertThat(result.reveal().path("parts").get(0).path("outcome").asText()).isEqualTo("WRONG");
    }

    @Test
    void partialCreditAndUnscoredProductionRemainDistinct() throws Exception {
        assertThat(judge("""
                {"type":"multi","options":[{"ok":true},{"ok":true},{"ok":false}]}
                """, "{\"choices\":[0]}").score()).isEqualTo(0.5);
        assertThat(judge("""
                {"type":"transform","accept":["is"],"known":[{"t":"be","verdict":"acceptable","note":"Regional"}]}
                """, "{\"text\":\"be\"}").outcome()).isEqualTo("ACCEPTABLE");
        var open = judge("{\"type\":\"open\",\"model\":[\"Example\"]}", "{\"text\":\"My example\"}");
        assertThat(open.outcome()).isEqualTo("SELF_REVIEW");
        assertThat(open.score()).isNull();
        var style = judge("""
                {"type":"transform","accept":["Preferred"],"known":[{"t":"Uncommon","verdict":"awkward","note":"A style preference"}]}
                """, "{\"text\":\"Uncommon\"}");
        assertThat(style.outcome()).isEqualTo("ACCEPTABLE");
        assertThat(style.score()).isEqualTo(1.0);
    }

    @Test
    void hugeNumbersCannotWrapAroundIntoAValidOption() throws Exception {
        JsonNode exercise = mapper.readTree("{\"type\":\"choice\",\"options\":[{\"ok\":true},{\"ok\":false}]}");
        for (String value : new String[]{"4294967296", "18446744073709551616", "-4294967296", "0.0", "\"0\""}) {
            assertThatThrownBy(() -> evaluator.evaluate(exercise, mapper.readTree("{\"choice\":" + value + "}")))
                    .isInstanceOf(GrammarException.class).hasMessage("INVALID_ANSWER");
        }
    }

    @Test
    void malformedTextIsRefusedInsteadOfCoercedOrTruncatedIntoACorrectAnswer() throws Exception {
        JsonNode exercise = mapper.readTree("{\"type\":\"transform\",\"accept\":[\"1\"]}");
        for (String value : new String[]{"1", "true", "[]", "{}", "null"}) {
            assertThatThrownBy(() -> evaluator.evaluate(exercise, mapper.readTree("{\"text\":" + value + "}")))
                    .isInstanceOf(GrammarException.class);
        }
        ((com.fasterxml.jackson.databind.node.ObjectNode) exercise).set("accept", mapper.valueToTree(java.util.List.of("a".repeat(400))));
        assertThatThrownBy(() -> evaluator.evaluate(exercise, mapper.createObjectNode().put("text", "a".repeat(401))))
                .isInstanceOf(GrammarException.class);
    }

    @Test
    void noErrorCannotBeCombinedWithPickingAnErrorAndStyleIsNeverABadSegment() throws Exception {
        JsonNode exercise = mapper.readTree("{\"type\":\"error\",\"segments\":[{\"t\":\"OK\"}]}");
        assertThatThrownBy(() -> evaluator.evaluate(exercise, mapper.readTree("{\"none\":true,\"picked\":[0]}")))
                .isInstanceOf(GrammarException.class);
        assertThat(judge("{\"type\":\"error\",\"segments\":[{\"t\":\"Preference\",\"bad\":true,\"style\":true}]}",
                "{\"none\":true}").outcome()).isEqualTo("CORRECT");
    }

    @Test
    void terminalPunctuationIsPreservedOnlyWhenTheExerciseRequiresIt() throws Exception {
        String strict = """
                {"type":"transform","terminalPunctuationMatters":true,"accept":["Had they left?"],
                 "known":[{"t":"Had they left.","verdict":"wrong","note":"Question mark required"}]}
                """;
        assertThat(judge(strict, "{\"text\":\"Had they left?\"}").outcome()).isEqualTo("CORRECT");
        assertThat(judge(strict, "{\"text\":\"Had they left.\"}").outcome()).isEqualTo("WRONG");
        assertThat(judge(strict, "{\"text\":\"Had they left\"}").outcome()).isEqualTo("UNRECOGNIZED");
        assertThat(judge("{\"type\":\"transform\",\"accept\":[\"Had they left?\"]}",
                "{\"text\":\"Had they left\"}").outcome()).isEqualTo("CORRECT");
        String blank = """
                {"type":"cloze","terminalPunctuationMatters":true,"blanks":{"1":{"accept":["?"],"closed":true}}}
                """;
        assertThat(judge(blank, "{\"blanks\":{\"1\":\"?\"}}").outcome()).isEqualTo("CORRECT");
        assertThat(judge(blank, "{\"blanks\":{\"1\":\".\"}}").outcome()).isEqualTo("WRONG");
    }

    @Test
    void aReorderMustConserveTheExactTokenMultiset() throws Exception {
        JsonNode exercise = mapper.readTree("{\"type\":\"order\",\"tokens\":[\"I\",\"am\",\"I\"],\"accept\":[[\"I\",\"am\",\"I\"]]}");
        assertThatThrownBy(() -> evaluator.evaluate(exercise, mapper.readTree("{\"seq\":[\"I\",\"am\"]}"))).isInstanceOf(GrammarException.class);
        assertThatThrownBy(() -> evaluator.evaluate(exercise, mapper.readTree("{\"seq\":[\"I\",\"am\",7]}"))).isInstanceOf(GrammarException.class);
    }
}
