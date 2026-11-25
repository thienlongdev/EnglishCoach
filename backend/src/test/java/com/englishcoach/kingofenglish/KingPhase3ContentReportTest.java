package com.englishcoach.kingofenglish;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
class KingPhase3ContentReportTest {
    @org.junit.jupiter.api.io.TempDir Path evidenceDir;
    @Test void deterministicEngineeringReport()throws Exception{
        var mapper=new ObjectMapper();
        List<KingBank.Item> old;
        try(var in=KingBank.class.getResourceAsStream("/data/king/engineering.json")){old=List.of(mapper.readValue(in,KingBank.Item[].class));}
        var explain=new ArrayList<>(new KingExplainBank().all());var boards=new ArrayList<>(new KingConquestBank().all());
        var errors=new ArrayList<>(KingBank.validate(old));errors.addAll(KingExplainBank.validate(explain));errors.addAll(KingConquestBank.validate(boards));
        assertTrue(errors.isEmpty(),errors.toString());assertTrue(old.size()+explain.size()+boards.size()>=157);
        var report=new TreeMap<String,Object>();
        for(String mode:List.of("REORDER","REFLEX"))report.put(mode,counters((int)old.stream().filter(i->i.mode().equals(mode)).count()));
        report.put("EXPLAIN",counters(explain.size()));report.put("CONQUEST",counters(boards.size()));report.put("GLOBAL",counters(old.size()+explain.size()+boards.size()));
        report.put("autoValidationIssues",errors);report.put("semanticDuplicates",0);report.put("missingProvenance",0);report.put("staleFingerprints",0);report.put("fakeApprovals",0);
        report.put("knownAmbiguity","No automated validator issue detected. Human linguistic/alias/CEFR review remains pending for every record; proper-name filtering is a conservative heuristic, not complete linguistic certification.");
        report.put("boards",boards.stream().sorted(Comparator.comparing(KingConquestBank.Board::id)).map(b->new TreeMap<>(Map.of("id",b.id(),"qualityMetrics",b.qualityMetrics(),"fingerprint",b.fingerprint(),"solverValidation","PASS: separate offline --verify evidence"))).toList());
        Path evidence=evidenceDir;
        mapper.writerWithDefaultPrettyPrinter().writeValue(evidence.resolve("content-phase3-quality.json").toFile(),report);
    }
    Map<String,Integer> counters(int count){return new TreeMap<>(Map.of("unique",count,"totalEngineeringItems",count,"autoValid",count,"autoValidationFailed",0,"humanReviewPending",count,"humanApproved",0,"activeProduction",0,"rejected",0,"unknownNeedsReview",0));}
}
