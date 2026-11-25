package com.englishcoach.exams.content;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Recover exact accepted bytes using recorded production identities and the canonical successor builder. */
class ExamAcceptedPackageReconstructionTest {
    @Test @SuppressWarnings("unchecked") void reconstructOnlyPackagesMatchingTheStoredProductionHash() throws Exception {
        var mapper=new ObjectMapper().findAndRegisterModules();
        Path root=Path.of("..");
        Path reconcile=root.resolve(System.getProperty("exams.reconstruct.reconcile","imports/exams/staging/phase-b/bulk-reconcile-3947d2"));
        var checkpoint=mapper.readValue(reconcile.resolve("production-checkpoint.json").toFile(),Map.class);
        var plan=mapper.readValue(reconcile.resolve("plan.json").toFile(),Map.class);
        var imports=(List<Map<String,Object>>)checkpoint.get("imports");
        List<Path> directories=new ArrayList<>();
        for(String relative:List.of("docs/exams-production-verification/20261006","imports/exams/staging/release-candidates","imports/exams/staging/phase-b")) {
            Path base=root.resolve(relative);
            try(var paths=Files.list(base)){directories.addAll(paths.filter(Files::isDirectory).toList());}
        }
        int recovered=0;
        for(var row:(List<Map<String,Object>>)plan.get("rows")) {
            if(!"ACCEPTED_PACKAGE_BYTES_NOT_LOCATED".equals(row.get("state")))continue;
            var accepted=(Map<String,Object>)row.get("accepted");
            String hash=String.valueOf(accepted.get("packageHash"));
            var currentRow=imports.stream().filter(i->hash.equals(i.get("content_hash"))).findFirst().orElseThrow();
            var current=ExamPackageIdentity.fromMap(currentRow.get("identity")).orElseThrow();
            var previous=imports.stream().map(i->ExamPackageIdentity.fromMap(i.get("identity"))).flatMap(Optional::stream)
                    .filter(i->i.sourceKey().equals(current.sourceKey()) && i.formLogicalKey().equals(current.formLogicalKey()) && i.formVersion()==current.formVersion()-1)
                    .findFirst();
            if(previous.isEmpty())continue;
            String filename=String.valueOf(row.get("testId")).replace("/","__")+".json";
            for(Path directory:directories) {
                Path file=directory.resolve(filename);if(!Files.isRegularFile(file))continue;
                ExamContentPackage fresh=mapper.readValue(file.toFile(),ExamContentPackage.class);
                if(!ExamPackageIdentity.of(fresh).semanticFingerprint().equals(current.semanticFingerprint()))continue;
                var rebuilt=ExamPackageSuccessorBuilder.build(fresh,previous.get(),current.formVersion(),current.packageVersion(),mapper).pkg();
                if(!hash.equals(rebuilt.manifest().contentHash()))continue;
                assertEquals(hash,new ExamContentPackageValidator(mapper).computeContentHash(rebuilt));
                Path destination=reconcile.resolve("accepted").resolve(filename);
                Files.writeString(destination,mapper.writerWithDefaultPrettyPrinter().writeValueAsString(rebuilt),StandardOpenOption.CREATE_NEW);
                row.put("state","EXACT_ACCEPTED_BYTES_RECONSTRUCTED");
                recovered++;break;
            }
        }
        assertTrue(recovered>0,"no exact accepted package bytes reconstructed");
        Files.writeString(reconcile.resolve("reconstructed-plan.json"),mapper.writerWithDefaultPrettyPrinter().writeValueAsString(plan),StandardOpenOption.CREATE_NEW);
    }
}
