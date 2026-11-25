package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

class ExamRubricExtensionTest {
    @Test void additionPreservesOldDefinitionsAndRefusesChangedRubricOrSpecification() throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules();
        var old = mapper.readValue(Path.of("../docs/exams-production-verification/20261006/expansion-resume-registry-before/ielts__cambridge-ielts-4__test-1.json").toFile(), ExamContentPackage.class);
        var fresh = mapper.readValue(Path.of("../imports/exams/staging/release-candidates/20261007-source-retry/ielts__cambridge-ielts-4__test-1.json").toFile(), ExamContentPackage.class);
        String prior = ExamPackageIdentity.of(old).definitionsDigest();
        assertTrue(ExamPackageIdentity.onlyAddsRubrics(fresh, prior));
        assertFalse(ExamPackageIdentity.onlyAddsRubrics(old, prior));
        ObjectNode changed = mapper.valueToTree(fresh);
        ((ObjectNode) changed.path("rubrics").get(0).path("criteria").path("taskAchievement")).put("weight", 2);
        assertFalse(ExamPackageIdentity.onlyAddsRubrics(mapper.treeToValue(changed, ExamContentPackage.class), prior));
        changed = mapper.valueToTree(fresh);
        ((ObjectNode) changed.path("specifications").get(0).path("timingPolicy")).put("altered", true);
        assertFalse(ExamPackageIdentity.onlyAddsRubrics(mapper.treeToValue(changed, ExamContentPackage.class), prior));
        assertFalse(ExamPackageIdentity.onlyAddsRubrics(fresh, "unknown"));
    }
}
