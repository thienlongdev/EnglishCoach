package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.util.*;
import java.security.MessageDigest;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Every published exercise is judged by the real evaluator against its own key: an accepted answer must be accepted, a known
 * wrong answer must be refused, a learner view must carry nothing that gives the key away. This proves consistency, not
 * linguistic truth: that is the review pass's work.
 */
class GrammarContentIntegrityTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final GrammarEvaluator evaluator = new GrammarEvaluator(mapper);

    @Test
    void packagedCatalogMatchesEveryAvailableTopicAndItsActualBytes() throws Exception {
        JsonNode plan, catalog;
        try (var in = new ClassPathResource("grammar/curriculum.json").getInputStream()) { plan = mapper.readTree(in); }
        try (var in = new ClassPathResource("grammar/catalog.json").getInputStream()) { catalog = mapper.readTree(in); }
        Map<String, JsonNode> indexed = new HashMap<>();
        for (JsonNode domain : catalog.path("domains")) for (JsonNode entry : domain.path("topics")) indexed.put(entry.path("slug").asText(), entry);
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        hash.update(mapper.writeValueAsBytes(plan));
        for (JsonNode domain : plan.path("domains")) for (JsonNode entry : domain.path("topics")) {
            String slug = entry.path("slug").asText();
            var resource = new ClassPathResource("grammar/topics/" + domain.path("id").asText() + "/" + slug + ".json");
            assertEquals(resource.exists(), indexed.get(slug).path("available").asBoolean(), slug + " availability is stale");
            if (!resource.exists()) continue;
            byte[] raw; try (var in = resource.getInputStream()) { raw = in.readAllBytes(); }
            hash.update(raw); JsonNode topic = mapper.readTree(raw);
            assertEquals(topic.path("version").asInt(), indexed.get(slug).path("version").asInt(), slug + " version is stale");
            for (JsonNode exercise : topic.path("exercises")) assertEquals(slug,
                    catalog.path("exerciseIndex").path(exercise.path("id").asText()).asText(), "Missing/wrong indexed exercise " + exercise.path("id"));
        }
        for (String kind : List.of("stories", "lab", "detective")) {
            Resource[] resources = new PathMatchingResourcePatternResolver().getResources("classpath:grammar/" + kind + "/*.json");
            Arrays.sort(resources, Comparator.comparing(Resource::getFilename));
            for (Resource resource : resources) try (var in = resource.getInputStream()) { hash.update(in.readAllBytes()); }
        }
        assertEquals(catalog.path("revision").asText(), HexFormat.of().formatHex(hash.digest()).substring(0, 16),
                "Catalog revision must describe the packaged content, not an earlier worktree snapshot");
    }

    private List<JsonNode> topics() throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (Resource r : new PathMatchingResourcePatternResolver().getResources("classpath:grammar/topics/*/*.json")) {
            try (var in = r.getInputStream()) {
                out.add(mapper.readTree(in));
            }
        }
        assertFalse(out.isEmpty());
        return out;
    }

    private static boolean good(String outcome) {
        return outcome.equals(GrammarEvaluator.CORRECT) || outcome.equals(GrammarEvaluator.ACCEPTABLE);
    }

    @Test
    void everyKeyIsConsistentWithTheEvaluator() throws Exception {
        List<String> problems = new ArrayList<>();
        for (JsonNode topic : topics()) {
            for (JsonNode ex : topic.path("exercises")) {
                String id = ex.path("id").asText();
                switch (ex.path("type").asText()) {
                    case "choice" -> {
                        for (int i = 0; i < ex.path("options").size(); i++) {
                            boolean ok = ex.path("options").get(i).path("ok").asBoolean(false);
                            String got = evaluator.evaluate(ex, mapper.createObjectNode().put("choice", i)).outcome();
                            if (ok != good(got)) problems.add(id + " option " + i + " judged " + got);
                        }
                    }
                    case "multi" -> {
                        ArrayNode all = mapper.createArrayNode();
                        for (int i = 0; i < ex.path("options").size(); i++) if (ex.path("options").get(i).path("ok").asBoolean(false)) all.add(i);
                        ObjectNode a = mapper.createObjectNode();
                        a.set("choices", all);
                        if (!good(evaluator.evaluate(ex, a).outcome())) problems.add(id + " full key not accepted");
                    }
                    case "cloze" -> {
                        ObjectNode blanks = mapper.createObjectNode();
                        ex.path("blanks").fields().forEachRemaining(b -> blanks.put(b.getKey(), b.getValue().path("accept").get(0).asText()));
                        ObjectNode a = mapper.createObjectNode();
                        a.set("blanks", blanks);
                        if (!good(evaluator.evaluate(ex, a).outcome())) problems.add(id + " first accepted answers refused");
                        ex.path("blanks").fields().forEachRemaining(b -> {
                            for (JsonNode accepted : b.getValue().path("accept")) {
                                ObjectNode one = blanks.deepCopy();
                                one.put(b.getKey(), accepted.asText());
                                ObjectNode ans = mapper.createObjectNode();
                                ans.set("blanks", one);
                                if (!good(evaluator.evaluate(ex, ans).outcome())) problems.add(id + " blank " + b.getKey() + " refuses " + accepted.asText());
                            }
                        });
                    }
                    case "order" -> {
                        for (JsonNode seq : ex.path("accept")) {
                            ObjectNode a = mapper.createObjectNode();
                            a.set("seq", seq);
                            if (!good(evaluator.evaluate(ex, a).outcome())) problems.add(id + " refuses a listed order");
                        }
                    }
                    case "transform" -> {
                        for (JsonNode s : ex.path("accept")) {
                            if (!good(evaluator.evaluate(ex, mapper.createObjectNode().put("text", s.asText())).outcome())) problems.add(id + " refuses " + s.asText());
                        }
                        for (JsonNode k : ex.path("known")) {
                            String want = k.path("verdict").asText();
                            String got = evaluator.evaluate(ex, mapper.createObjectNode().put("text", k.path("t").asText())).outcome();
                            if (want.equals("wrong") && !got.equals(GrammarEvaluator.WRONG)) problems.add(id + " known wrong judged " + got + ": " + k.path("t").asText());
                        }
                    }
                    case "error" -> {
                        ObjectNode a = mapper.createObjectNode();
                        if (ex.path("noError").asBoolean(false)) a.put("none", true);
                        else {
                            ArrayNode picked = a.putArray("picked");
                            for (int i = 0; i < ex.path("segments").size(); i++) if (ex.path("segments").get(i).path("bad").asBoolean(false)) picked.add(i);
                        }
                        if (!good(evaluator.evaluate(ex, a).outcome())) problems.add(id + " key not accepted");
                    }
                    case "match" -> {
                        ObjectNode pairs = mapper.createObjectNode();
                        for (int i = 0; i < ex.path("pairs").size(); i++) pairs.put(String.valueOf(i), ex.path("pairs").get(i).path("b").asText());
                        ObjectNode a = mapper.createObjectNode();
                        a.set("pairs", pairs);
                        if (!good(evaluator.evaluate(ex, a).outcome())) problems.add(id + " key not accepted");
                    }
                    case "classify" -> {
                        ObjectNode cats = mapper.createObjectNode();
                        for (int i = 0; i < ex.path("items").size(); i++) cats.put(String.valueOf(i), ex.path("items").get(i).path("cat").asText());
                        ObjectNode a = mapper.createObjectNode();
                        a.set("cats", cats);
                        if (!good(evaluator.evaluate(ex, a).outcome())) problems.add(id + " key not accepted");
                    }
                    default -> { }
                }
            }
        }
        assertTrue(problems.isEmpty(), String.join("\n", problems));
    }

    @Test
    void aLearnerViewNeverCarriesTheKey() throws Exception {
        GrammarContent content = new GrammarContent(mapper);
        Set<String> forbidden = Set.of("ok", "accept", "known", "explain", "bad", "fix", "note", "tag", "noError", "style", "pairs", "model", "checklist", "closed", "cat");
        for (JsonNode topic : topics()) {
            for (JsonNode ex : topic.path("exercises")) {
                ObjectNode view = content.learnerExercise(ex);
                List<String> found = new ArrayList<>();
                walk(view, forbidden, found);
                assertTrue(found.isEmpty(), ex.path("id").asText() + " leaks " + found);
            }
            if (content.meta(topic.path("slug").asText()).isPresent()) {
                JsonNode served = mapper.readTree(content.load(topic.path("slug").asText()).learnerJson());
                for (JsonNode ex : served.path("exercises")) assertNotEquals("check", ex.path("use").asText(), "a check-only item reached the page");
            }
        }
    }

    private static void walk(JsonNode node, Set<String> forbidden, List<String> found) {
        if (node.isObject()) {
            node.fields().forEachRemaining(e -> {
                // a diagram inside an option is display data of its own shape
                if (e.getKey().equals("diagram")) return;
                if (forbidden.contains(e.getKey())) found.add(e.getKey());
                walk(e.getValue(), forbidden, found);
            });
        } else if (node.isArray()) node.forEach(n -> walk(n, forbidden, found));
    }

    @Test
    void theEvaluatorKnowsWhatItDoesNotKnow() throws Exception {
        JsonNode ex = mapper.readTree("""
            {"id":"t","type":"transform","explain":"e","source":"s","instruction":"i","model":"I have eaten.","accept":["I have eaten"],
             "known":[{"t":"I eaten","verdict":"wrong","note":"n","tag":"x"}]}""");
        assertEquals(GrammarEvaluator.UNRECOGNIZED, evaluator.evaluate(ex, mapper.createObjectNode().put("text", "I've eaten.")).outcome(), "alternatives must be explicitly authored");
        assertEquals(GrammarEvaluator.WRONG, evaluator.evaluate(ex, mapper.createObjectNode().put("text", "i eaten")).outcome());
        GrammarEvaluator.Verdict unknown = evaluator.evaluate(ex, mapper.createObjectNode().put("text", "I ate already"));
        assertEquals(GrammarEvaluator.UNRECOGNIZED, unknown.outcome(), "never a false wrong");
        assertNull(unknown.score(), "an unrecognized answer never counts");
    }

    @Test
    void itsAndItsStayDifferent() {
        assertNotEquals(GrammarEvaluator.norm("its", false), GrammarEvaluator.norm("it's", false));
        assertEquals("she isn't here", GrammarEvaluator.norm("She  isn’t here.", false));
    }

    @Test
    void masteryIsNeverDecidedOnThinEvidence() {
        assertEquals("A2", GrammarService.suggestLevel(List.of(new GrammarDtos.LevelResult("A1", 5, 100), new GrammarDtos.LevelResult("A2", 5, 40), new GrammarDtos.LevelResult("B1", 5, 90))), "the first band not yet solid");
    }
}
