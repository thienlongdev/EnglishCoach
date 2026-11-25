package com.englishcoach.exams.staging;

import com.englishcoach.exams.content.*;
import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.Test;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ExamCorpusHashParityTest {
    @Test void selectedStagedPackageHashIsCanonical() throws Exception {
        String selected = System.getProperty("exams.hashParity.package");
        org.junit.jupiter.api.Assumptions.assumeTrue(selected != null);
        Path root = Path.of("..").toAbsolutePath().normalize();
        Path file = root.resolve(selected).normalize();
        assertTrue(file.startsWith(root));
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules()
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        JsonNode raw = mapper.readTree(file.toFile());
        ExamContentPackage pkg = mapper.treeToValue(raw, ExamContentPackage.class);
        var validator = new ExamContentPackageValidator(mapper);
        String computed = validator.computeContentHash(pkg);
        var now = java.time.Instant.now();
        var closure = validator.validate(pkg, now);
        var structure = com.englishcoach.exams.validation.ExamFormValidator.validate(
                com.englishcoach.exams.validation.ExamContentTree.fromPackage(pkg, mapper), mapper, now);
        List<String> drift = new ArrayList<>();
        differences(raw, mapper.valueToTree(pkg), "", drift);
        String evidence = System.getProperty("exams.hashParity.evidence");
        if (evidence != null) Files.writeString(root.resolve(evidence),
                mapper.writerWithDefaultPrettyPrinter().writeValueAsString(Map.of(
                        "declaredHash",pkg.manifest().contentHash(),"javaHash",computed,
                        "serializationDriftPaths",drift,"closureErrors",closure.errors(),
                        "structuralValidation",structure)),StandardOpenOption.CREATE_NEW);
        assertEquals(pkg.manifest().contentHash(),computed);
    }

    @Test void sealedRuntimeHashes() throws Exception {
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules()
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        var validator = new ExamContentPackageValidator(mapper);
        List<Map<String,Object>> rows = new ArrayList<>();
        for (String id : ExamOriginalPracticeBootstrapService.PACKAGES) {
            Path file = Path.of("src/main/resources/exams/original-practice", id + ".json");
            JsonNode raw = mapper.readTree(file.toFile());
            ExamContentPackage pkg = mapper.treeToValue(raw, ExamContentPackage.class);
            String javaHash = validator.computeContentHash(pkg);
            assertEquals(pkg.manifest().contentHash(), javaHash, id);
            List<String> differences = new ArrayList<>();
            differences(raw, mapper.valueToTree(pkg), "", differences);
            rows.add(Map.of("packageId", id, "javaHash", javaHash, "serializationDriftPaths", differences));
        }
        String evidence = System.getProperty("exams.hashParity.evidence");
        if (evidence != null) Files.writeString(Path.of(evidence),
                mapper.writerWithDefaultPrettyPrinter().writeValueAsString(rows), StandardOpenOption.CREATE_NEW);
    }
    static void differences(JsonNode a, JsonNode b, String path, List<String> out) {
        if (a.equals(b)) return;
        if (a.isObject() && b.isObject()) {
            Set<String> names = new TreeSet<>();
            a.fieldNames().forEachRemaining(names::add); b.fieldNames().forEachRemaining(names::add);
            for (String name : names) {
                if (a.get(name) == null || b.get(name) == null) out.add(path + "/" + name);
                else differences(a.get(name), b.get(name), path + "/" + name, out);
            }
        } else if (a.isArray() && b.isArray() && a.size()==b.size()) {
            for (int n=0;n<a.size();n++) differences(a.get(n),b.get(n),path+"/"+n,out);
        } else out.add(path);
    }
}
