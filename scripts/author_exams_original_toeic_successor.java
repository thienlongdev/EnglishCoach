import com.englishcoach.exams.content.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.*;
import java.util.*;

/** Restore the original parking passage only after exact question/option/key agreement. */
class author_exams_original_toeic_successor {
    public static void main(String[] args) throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules();
        var folder = Path.of("backend/src/main/resources/exams/original-practice");
        var key = "EC_ORIGINAL_TOEIC_LR_PRACTICE_20261006";
        var previous = mapper.readValue(folder.resolve(key + ".json").toFile(), ExamContentPackage.class);
        var source = mapper.readTree(Path.of("content/exams/original-pilot/TOEIC/TOEIC_LR_PILOT_001_V1.json").toFile());
        var root = (ObjectNode) mapper.valueToTree(previous);
        var group = previous.groups().stream().filter(g -> g.logicalGroupKey().endsWith("TOEIC_LR_P7_P01_G01")).findFirst().orElseThrow();
        var items = previous.items().stream().filter(i -> i.groupId().equals(group.id())).toList();
        if (items.size() != 3) throw new IllegalStateException("PARKING_QUESTION_COUNT");
        for (var item : items) {
            var sourceItem = java.util.stream.StreamSupport.stream(source.path("items").spliterator(), false)
                    .filter(i -> i.path("prompt").asText().equals(item.prompt())).findFirst().orElseThrow();
            if (!sourceItem.path("optionDefinitions").path("options").equals(mapper.valueToTree(item.optionDefinitions()).path("options")))
                throw new IllegalStateException("PARKING_OPTIONS_MISMATCH");
            var sourceAnswer = java.util.stream.StreamSupport.stream(source.path("answerSpecs").spliterator(), false)
                    .filter(a -> a.path("itemId").asText().equals(sourceItem.path("id").asText())).findFirst().orElseThrow();
            var answer = previous.answerSpecs().stream().filter(a -> a.itemId().equals(item.id())).findFirst().orElseThrow();
            if (!sourceAnswer.path("acceptedAnswers").equals(mapper.valueToTree(answer.acceptedAnswers())))
                throw new IllegalStateException("PARKING_KEY_MISMATCH");
        }
        var sourceStimulus = java.util.stream.StreamSupport.stream(source.path("stimuli").spliterator(), false)
                .filter(s -> s.path("title").asText().equals("Riverside Business Center parking notice")).findFirst().orElseThrow();
        var bound = previous.groupStimuli().stream().filter(gs -> gs.groupId().equals(group.id())).findFirst().orElseThrow().stimulusId();
        for (var node : root.path("stimuli")) if (node.path("id").asText().equals(bound.toString())) {
            var stimulus = (ObjectNode) node;
            stimulus.set("title", sourceStimulus.path("title"));
            var body = sourceStimulus.path("bodyPayload").deepCopy();
            ((ObjectNode) body).put("text", body.path("text").asText().replaceAll("\\\\+n", "\n"));
            stimulus.set("bodyPayload", body);
            stimulus.put("contentHash", com.englishcoach.exams.service.ExamManifestService.canonicalHash(mapper.convertValue(body, Map.class)));
        }
        var fresh = mapper.treeToValue(root, ExamContentPackage.class);
        var successor = ExamPackageSuccessorBuilder.build(fresh, ExamPackageIdentity.of(previous), 2, 2, mapper);
        var validation = new ExamContentPackageValidator(mapper).validate(successor.pkg());
        if (!validation.valid()) throw new IllegalStateException(validation.errors().toString());
        mapper.writerWithDefaultPrettyPrinter().writeValue(folder.resolve(key + "_V2.json").toFile(), successor.pkg());
        System.out.println("PARKING_SOURCE_QUESTIONS_OPTIONS_KEYS_MATCH=3; successor=" + successor.pkg().form().id()
                + "; changed=" + successor.changedPlacements() + "; reused=" + successor.reusedPlacements().size());
    }
}
