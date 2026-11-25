package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Read-only operator ledger. Startup pins one complete release; it never approves or activates.
 * Filesystem access is the operator authorization boundary, not an HTTP endpoint.
 */
final class KingSnapshot {
    private static final ObjectMapper JSON=new ObjectMapper();
    private static final Set<String> SUPPORTED_VALIDATORS=Set.of("king-snapshot-1","king-snapshot-2","king-snapshot-3");
    private final JsonNode definition, active;
    private final Path artifacts;
    private final Set<String> ids, words;
    private Path store;
    private KingSnapshot(JsonNode definition, JsonNode active, Path artifacts) {
        var retained=new ObjectMapper().createObjectNode();retained.set("version",definition.path("version"));
        retained.set("report",new ObjectMapper().createObjectNode().set("counts",definition.path("report").path("counts")));
        this.definition=retained;this.active=active;this.artifacts=artifacts;
        var selected=new HashSet<String>();definition.path("eligibleIds").elements().forEachRemaining(list->list.forEach(id->{
            if(!selected.add(id.asText()))throw new IllegalStateException("Duplicate snapshot ID");
        }));ids=Set.copyOf(selected);
        var lexicon=KingCorpus.strings(definition.path("eligibleLexicon"));words=Set.copyOf(lexicon);
        if(words.size()!=lexicon.size()||words.size()!=definition.path("report").path("counts").path("LEXICON").path("valid").asInt(-1))throw new IllegalStateException("Invalid King snapshot lexicon population");
        if(!definition.path("eligibleIds").isObject()||definition.path("eligibleIds").size()!=4)throw new IllegalStateException("Invalid King snapshot mode population");
        for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST"))if(definition.path("eligibleIds").path(mode).size()!=definition.path("report").path("counts").path(mode).path("valid").asInt(-1))throw new IllegalStateException("Invalid King snapshot mode counts");
    }
    static KingSnapshot read(String directory, boolean productionProfile, boolean localTestProfile) {
        if(directory==null||directory.isBlank())return null;
        try {
            Path store=Path.of(directory).toAbsolutePath().normalize();var json=JSON;
            if(!Files.exists(store.resolve("state.json")))return null;
            var state=json.readTree(Files.readAllBytes(store.resolve("state.json")));var active=state.path("active");
            if(state.path("schemaVersion").asInt()!=1)throw new IllegalStateException("Unsupported King snapshot ledger");
            if(active.isNull()||active.isMissingNode())return null;
            String id=active.path("snapshotId").asText(),fingerprint=active.path("fingerprint").asText(),target=active.path("target").asText();
            if(!id.matches("[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}")||!fingerprint.matches("[a-f0-9]{64}"))throw new IllegalStateException("Invalid King snapshot identity");
            boolean local=target.equals("LOCAL_TEST");
            if(local&&(productionProfile||!localTestProfile)||!local&&!target.equals("PRODUCTION"))throw new IllegalStateException("Local King test approval prohibited outside explicit local test profile");
            var record=state.path("snapshots").path(id);var approval=record.path("approval");
            if(!record.path("reviewStatus").asText().equals("HUMAN_APPROVED")||!approval.path("decision").asText().equals("APPROVE")||
               !approval.path("target").asText().equals(target)||!approval.path("acknowledgedReview").asBoolean()||approval.path("reviewer").asText().isBlank()||
               !approval.path("fingerprint").asText().equals(fingerprint)||!record.path("fingerprint").asText().equals(fingerprint)||
               !approval.path("kind").asText().equals(local?"LOCAL_OWNER_TEST":"HUMAN_PACKAGE_REVIEW")||
               !active.path("status").asText().equals(local?"LOCAL_TEST_ACTIVE":"PRODUCTION_ACTIVE"))throw new IllegalStateException("King active snapshot lacks exact human approval");
            byte[] bytes=Files.readAllBytes(store.resolve(id+".json"));
            if(!sha(bytes).equals(fingerprint))throw new IllegalStateException("King snapshot fingerprint changed");
            var definition=json.readTree(bytes);
            String validator=definition.path("validatorVersion").asText();
            if(definition.path("schemaVersion").asInt()!=1||!definition.path("snapshotId").asText().equals(id)||
               !SUPPORTED_VALIDATORS.contains(validator)||!definition.path("validationResult").asText().equals("AUTO_VALIDATED"))throw new IllegalStateException("Unvalidated King snapshot");
            // Prior versions retain local/revalidation compatibility; production needs the repaired invariant.
            if(!local&&!validator.equals("king-snapshot-3"))throw new IllegalStateException("King production requires repaired validator");
            if(validator.equals("king-snapshot-3")&&(!approval.path("snapshotId").asText().equals(id)||
                !approval.path("validatorVersion").asText().equals(validator)||!approval.path("packageHashes").equals(definition.path("artifacts"))))throw new IllegalStateException("King approval missing exact package binding");
            String packagePath=record.path("package").asText();
            if(packagePath.isBlank())throw new IllegalStateException("Missing King package path");
            Path artifacts=store.resolve(packagePath).toAbsolutePath().normalize();
            var result=new KingSnapshot(definition,active,artifacts);
            result.store=store;
            var fields=definition.path("artifacts").fields();int checked=0;
            while(fields.hasNext()) {var file=fields.next();Path path=artifacts.resolve(file.getKey()).normalize();
                if(!path.startsWith(artifacts)||!file.getValue().asText().matches("[a-f0-9]{64}")||!sha(Files.readAllBytes(path)).equals(file.getValue().asText()))throw new IllegalStateException("King approved artifact changed");checked++;
            }
            for(String name:List.of("manifest.json","sources.lock.json","ATTRIBUTION.md","king-core.sqlite.gz","king-phrases-cc-by-sa.sqlite.gz"))
                if(!definition.path("artifacts").has(name))throw new IllegalStateException("King snapshot missing artifact closure");
            if(checked<6)throw new IllegalStateException("King snapshot missing license notices");
            return result;
        } catch(Exception e) {throw new IllegalStateException("King snapshot failed closed",e);}
    }
    static String sha(byte[] bytes) {
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
        catch(Exception e){throw new IllegalStateException(e);}
    }
    InputStream resource(String name) {try{return Files.newInputStream(artifacts.resolve(name));}catch(IOException e){throw new UncheckedIOException(e);}}
    boolean includes(String id){return ids.contains(id);}
    boolean includesWord(String word){return words.contains(word);}
    boolean current() {
        try {
            var pointer=JSON.readTree(Files.readAllBytes(store.resolve("state.json"))).path("active");
            return pointer.equals(active);
        }catch(Exception e){return false;}
    }
    void verifyLoaded(KingCorpus corpus) {
        int total=0;
        for(String mode:List.of("REORDER","REFLEX","EXPLAIN","CONQUEST")) {
            int expected=definition.path("report").path("counts").path(mode).path("valid").asInt(-1);
            if(corpus.count(mode)!=expected)throw new IllegalStateException("King snapshot eligibility count mismatch");total+=expected;
        }
        if(total!=ids.size())throw new IllegalStateException("King snapshot unknown mode IDs");
        for(String word:words)if(!corpus.wordEligible(word))throw new IllegalStateException("King snapshot missing lexicon key");
    }
    Map<String,Object> status(){return Map.of("snapshotId",active.path("snapshotId").asText(),"version",definition.path("version").asText(),
        "fingerprint",active.path("fingerprint").asText(),"activationStatus",active.path("status").asText(),"activatedAt",active.path("activatedAt").asText(),
        "reviewStatus","HUMAN_APPROVED","validationStatus","AUTO_VALIDATED");}
}
