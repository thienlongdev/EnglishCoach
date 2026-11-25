package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ExamPracticeAdditivePackageBuilderTest {
    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());
    private ExamContentPackage accepted() throws Exception {
        return mapper.readValue(Path.of("../docs/exams-production-verification/20261006/phase-b-ybm2-accepted-before-additive/toeic__ybm-vol-2__test-3.json").toFile(),ExamContentPackage.class);
    }
    private ExamContentPackage candidate() throws Exception {
        return mapper.readValue(Path.of("../imports/exams/staging/phase-b/ybm2-projection-3930/toeic__ybm-vol-2__test-3.json").toFile(),ExamContentPackage.class);
    }
    private ExamPracticePackageProjection.Result result(ExamContentPackage pkg) {
        return new ExamPracticePackageProjection.Result(pkg,Set.of("TOEIC_PART_2"),Map.of());
    }
    @Test void addsListeningWhileRetainingAllAcceptedReadingRows() throws Exception {
        var prior=accepted(); var fresh=candidate();
        String priorBytes=mapper.writeValueAsString(prior),freshBytes=mapper.writeValueAsString(fresh);
        var combined=ExamPracticeAdditivePackageBuilder.build(prior,result(fresh),mapper);
        assertEquals(Set.of("TOEIC_PART_2","TOEIC_PART_5"),combined.retainedScopes());
        assertEquals(55,combined.pkg().items().size());
        assertEquals(2,combined.pkg().sections().size());
        assertEquals(List.of(1,2),combined.pkg().sections().stream().map(s->s.ordinal()).toList());
        assertTrue(combined.pkg().items().containsAll(prior.items()));
        assertTrue(combined.pkg().answerSpecs().containsAll(prior.answerSpecs()));
        assertEquals(prior.sources(),combined.pkg().sources(),"shared source definition stays immutable");
        assertEquals(priorBytes,mapper.writeValueAsString(prior));
        assertEquals(freshBytes,mapper.writeValueAsString(fresh));
        assertEquals(combined.pkg().manifest().contentHash(),new ExamContentPackageValidator(mapper).computeContentHash(combined.pkg()));
        assertEquals(mapper.writeValueAsString(combined),mapper.writeValueAsString(ExamPracticeAdditivePackageBuilder.build(prior,result(fresh),mapper)));
    }
    @Test void differentSourceIdentityIsRejected() throws Exception {
        ObjectNode changed=mapper.valueToTree(candidate());
        ((ObjectNode)changed.path("form")).put("logicalKey","OTHER_FORM");
        assertThrows(IllegalArgumentException.class,()->ExamPracticeAdditivePackageBuilder.build(accepted(),result(mapper.treeToValue(changed,ExamContentPackage.class)),mapper));
    }
    @Test void sourceRightsDifferencesCannotUseInformationalReconciliation() throws Exception {
        ObjectNode changed=mapper.valueToTree(candidate());
        ((ObjectNode)changed.path("sources").get(0).path("referenceMeta")).put("rightsStatus","ALTERED");
        var error=assertThrows(IllegalArgumentException.class,()->ExamPracticeAdditivePackageBuilder.build(accepted(),result(mapper.treeToValue(changed,ExamContentPackage.class)),mapper));
        assertEquals("ADDITIVE_SHARED_DEFINITION_CHANGED:sources",error.getMessage());
    }
    @Test void conflictingAcceptedQuestionCannotBeSilentlyDropped() throws Exception {
        var prior=accepted(); ObjectNode changed=mapper.valueToTree(prior);
        ((ObjectNode)changed.path("items").get(0)).put("prompt","Changed accepted content");
        var error=assertThrows(IllegalArgumentException.class,()->ExamPracticeAdditivePackageBuilder.build(prior,result(mapper.treeToValue(changed,ExamContentPackage.class)),mapper));
        assertEquals("ADDITIVE_RETAINED_SCOPE_CHANGED:READING_PART_5",error.getMessage());
    }
    @Test void combinedClosureMustPassTheUnchangedProductionPracticeGate() throws Exception {
        var combined=ExamPracticeAdditivePackageBuilder.build(accepted(),result(candidate()),mapper);
        var media=ExamMediaImportPlan.plan(combined.pkg(),Path.of(".."),true);
        var gate=ExamPracticeReleaseReadiness.evaluate(combined,media,mapper,Instant.now());
        assertTrue(gate.importReady(),gate.blockers().toString());
        assertEquals(Set.of("TOEIC_PART_2","TOEIC_PART_5"),gate.scopes());
    }
}
