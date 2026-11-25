package com.englishcoach.exams.content;

import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.service.ExamPublicationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

/** Hash-pinned registry or submitted Practice content. Canonical planner/importer/lifecycle; no input-selected basis,
 * source file access, SQL mutations, QA decisions, forced replacements or full simulation grants.
 */
@Service @RequiredArgsConstructor
public class ExamCorpusPracticeReleaseService {
    private final ObjectMapper mapper;
    private final NamedParameterJdbcTemplate jdbc;
    private final ExamContentPackageImporter importer;
    private final ExamPublicationService publication;
    private final ExamPracticeService practice;
    private final ExamObjectStorage storage;

    @Transactional(rollbackFor = Exception.class)
    public List<Map<String,Object>> releaseQualifiedBatch(Long actor) throws Exception {
        var rows=registryRows();
        return releaseRows(actor,rows);
    }

    /** One fixed registry entry per request keeps Azure import work within the existing edge timeout. */
    @Transactional(rollbackFor = Exception.class)
    public List<Map<String,Object>> releaseQualifiedPackage(Long actor, int packageIndex) throws Exception {
        var rows=registryRows();
        if(packageIndex<0 || packageIndex>=rows.size()) throw new IllegalArgumentException("CORPUS_RELEASE_INDEX_INVALID");
        var receipts=releaseRows(actor,List.of(rows.get(packageIndex)));
        List<Map<String,Object>> result=new ArrayList<>();
        for(var receipt:receipts) {
            Map<String,Object> row=new LinkedHashMap<>(receipt);
            row.put("packageIndex",packageIndex); row.put("packageCount",rows.size()); result.add(Map.copyOf(row));
        }
        return List.copyOf(result);
    }

    /** Content-only delivery through the existing gates, without an image per package. */
    @Transactional(rollbackFor = Exception.class)
    public List<Map<String,Object>> releaseSubmittedPackage(Long actor, ExamContentPackage pkg) throws Exception {
        if(actor==null||actor<=0 || pkg==null || pkg.manifest()==null || pkg.items()==null || pkg.items().isEmpty())
            throw new IllegalArgumentException("CORPUS_RELEASE_PACKAGE_INVALID");
        String hash=new ExamContentPackageValidator(mapper).computeContentHash(pkg);
        if(!hash.equals(pkg.manifest().contentHash())) throw new IllegalStateException("CORPUS_RELEASE_HASH_MISMATCH");
        var tree=com.englishcoach.exams.validation.ExamContentTree.fromPackage(pkg,mapper);
        var report=com.englishcoach.exams.validation.ExamFormValidator.validate(tree,mapper,Instant.now());
        boolean fullSourceFamily=ExamPackageSourceProvenance.fromManifest(pkg.manifest())
                .map(p->Set.of("ybm","economy").contains(p.collection())).orElse(false);
        if(fullSourceFamily && pkg.items().size()==200 && !report.fullSimulationEligible())
            throw new IllegalStateException("CORPUS_FULL_TOEIC_SOURCE_REQUIRED");
        var scopes=com.englishcoach.exams.practice.ExamPracticeReadiness.evaluate(tree,report,
                ExamRunnerCapabilities.CURRENT,new com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts(true,true),mapper);
        Set<String> codes=new TreeSet<>();
        for(var scope:scopes) {
            if(!scope.ready()) throw new IllegalStateException("CORPUS_PRACTICE_RUNTIME_NOT_READY");
            codes.add(scope.scope().scopeCode());
        }
        var projection=new ExamPracticePackageProjection.Result(pkg,codes,Map.of());
        var media=verifiedProductionMedia(pkg);
        var gate=ExamPracticeReleaseReadiness.evaluate(projection,media,mapper,Instant.now());
        var state=new ExamImportStateJdbcReader(jdbc,mapper);
        var plan=ExamImportPlanner.planPractice(pkg,gate,media,List.of(),state,ExamImportPlanner.Target.PRODUCTION);
        if(plan.operation()==ExamImportPlanner.Operation.BLOCKED) throw new IllegalStateException("CORPUS_PRACTICE_IMPORT_BLOCKED");
        if(plan.operation()==ExamImportPlanner.Operation.ALREADY_IMPORTED) {
            UUID existing=UUID.fromString(String.valueOf(plan.matchedImport().get("formId")));
            Set<String> active=new TreeSet<>();
            for(var scope:practice.evaluateForm(existing).scopes()) if(scope.ready()) active.add(scope.scope().scopeCode());
            if(!active.containsAll(codes)) throw new IllegalStateException("CORPUS_IMPORTED_PRACTICE_NOT_ACTIVE");
            return List.of(Map.of("packageId",pkg.manifest().packageId(),"operation","ALREADY_IMPORTED","planId",plan.planId(),
                    "formId",existing,"scopeCodes",codes,"packageIndex",0,"packageCount",1));
        }
        if(plan.operation()==ExamImportPlanner.Operation.NEW_VERSION) {
            var incoming=ExamPackageIdentity.of(pkg);
            var previous=state.importsForSource(incoming.sourceKey()).stream()
                    .filter(v->v.formId().toString().equals(String.valueOf(plan.matchedImport().get("formId"))))
                    .findFirst().orElseThrow();
            var accepted=practice.evaluateForm(previous.formId()).scopes();
            Set<String> acceptedCodes=new TreeSet<>();
            for(var scope:accepted) if(scope.ready()) acceptedCodes.add(scope.scope().scopeCode());
            if(!codes.containsAll(acceptedCodes)) throw new IllegalStateException("CORPUS_ACCEPTED_SCOPE_REMOVAL_REFUSED");
            if(!acceptedCodes.isEmpty()) {
                if(previous.identity()==null || !incoming.placements().keySet().containsAll(previous.identity().placements().keySet()))
                    throw new IllegalStateException("CORPUS_ACCEPTED_GRAPH_REMOVAL_REFUSED");
                // Source-covered YBM/Economy Parts may correct content in a new immutable
                // version. The canonical executor preserves all predecessor rows and attempts.
                // Other source families retain the stricter equal-content requirement.
                if(!fullSourceFamily) {
                    for(var placement:previous.identity().placements().entrySet()) {
                        if(!Objects.equals(placement.getValue().get("digest"),incoming.placements().get(placement.getKey()).get("digest")))
                            throw new IllegalStateException("CORPUS_ACCEPTED_CONTENT_CHANGE_REFUSED");
                    }
                }
            }
        }
        var executor=new ExamImportExecutor(importer,state,mapper);
        var outcome=executor.execute(plan,pkg,actor);
        publication.activateQualifiedPractice(outcome.importedPackage(),codes,actor,practice);
        return List.of(Map.of("packageId",pkg.manifest().packageId(),"operation",plan.operation().name(),"planId",plan.planId(),
                "formId",outcome.result().formId(),"scopeCodes",codes,"packageIndex",0,"packageCount",1));
    }

    @SuppressWarnings("unchecked")
    private List<Map<String,Object>> registryRows() throws Exception {
        Map<String,Object> registry;
        try(var input=getClass().getResourceAsStream("/exams/corpus-practice-release/registry.json")) {
            if(input==null) throw new IllegalStateException("CORPUS_RELEASE_REGISTRY_UNAVAILABLE");
            registry=mapper.readValue(input,Map.class);
        }
        if(!"exam-corpus-practice-release-v1".equals(registry.get("version")) || !ExamOwnerProductionAuthorization.DECISION_REF.equals(registry.get("ownerDecision")))
            throw new IllegalStateException("CORPUS_RELEASE_REGISTRY_INVALID");
        return (List<Map<String,Object>>)registry.get("packages");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String,Object>> releaseRows(Long actor,List<Map<String,Object>> rows) throws Exception {
        if(actor==null||actor<=0) throw new IllegalArgumentException("CONTENT_IMPORT_ACTOR_REQUIRED");
        var state=new ExamImportStateJdbcReader(jdbc,mapper); var executor=new ExamImportExecutor(importer,state,mapper);
        List<Map<String,Object>> results=new ArrayList<>();
        for(var row:rows) {
            String filename=String.valueOf(row.get("file"));
            if(!filename.matches("(?:ielts|toeic)__[a-z0-9-]+__test-[1-9][0-9]*\\.json")) throw new IllegalStateException("CORPUS_RELEASE_PATH_INVALID");
            ExamContentPackage pkg;
            try(var input=getClass().getResourceAsStream("/exams/corpus-practice-release/"+filename)) { pkg=mapper.readValue(input,ExamContentPackage.class); }
            String hash=new ExamContentPackageValidator(mapper).computeContentHash(pkg);
            if(!hash.equals(row.get("packageHash"))||!hash.equals(pkg.manifest().contentHash())) throw new IllegalStateException("CORPUS_RELEASE_HASH_MISMATCH");
            Set<String> codes=new TreeSet<>((List<String>)row.get("scopeCodes"));
            var projection=new ExamPracticePackageProjection.Result(pkg,codes,Map.of());
            var media=verifiedProductionMedia(pkg);
            var gate=ExamPracticeReleaseReadiness.evaluate(projection,media,mapper,Instant.now());
            var plan=ExamImportPlanner.planPractice(pkg,gate,media,List.of(),state,ExamImportPlanner.Target.PRODUCTION);
            if(plan.operation()==ExamImportPlanner.Operation.ALREADY_IMPORTED) {
                UUID existing=UUID.fromString(String.valueOf(plan.matchedImport().get("formId")));
                var live=practice.evaluateForm(existing).scopes();
                Set<String> ready=new TreeSet<>();
                for(var scope:live) { if(!scope.ready()) throw new IllegalStateException("CORPUS_IMPORTED_PRACTICE_NOT_ACTIVE"); ready.add(scope.scope().scopeCode()); }
                if(!ready.equals(codes)) throw new IllegalStateException("CORPUS_IMPORTED_SCOPE_MISMATCH");
                results.add(Map.of("packageId",pkg.manifest().packageId(),"operation","ALREADY_IMPORTED","planId",plan.planId()));
                continue;
            }
            var outcome=executor.execute(plan,pkg,actor);
            publication.activateQualifiedPractice(outcome.importedPackage(),codes,actor,practice);
            results.add(Map.of("packageId",pkg.manifest().packageId(),"operation",plan.operation().name(),"planId",plan.planId(),"formId",outcome.result().formId(),"scopeCodes",codes));
        }
        return List.copyOf(results);
    }
    private ExamMediaImportPlan.Plan verifiedProductionMedia(ExamContentPackage pkg) throws Exception {
        List<ExamMediaImportPlan.Entry> entries=new ArrayList<>();
        for(var asset:pkg.assets()) {
            if(!(asset.mimeType().startsWith("audio/")||asset.mimeType().startsWith("image/"))
                    ||!"VALIDATED".equals(asset.validationState())||!storage.objectExists(asset.objectKey()))
                throw new IllegalStateException("CORPUS_RELEASE_MEDIA_UNAVAILABLE");
            MessageDigest digest=MessageDigest.getInstance("SHA-256"); long bytes=0;
            try(var stream=storage.getObjectStream(asset.objectKey())) { byte[] buffer=new byte[65536]; int read;
                while((read=stream.read(buffer))!=-1) { digest.update(buffer,0,read); bytes+=read; }
            }
            if(!HexFormat.of().formatHex(digest.digest()).equals(asset.sha256Hash()) || bytes!=asset.byteSize())
                throw new IllegalStateException("CORPUS_RELEASE_MEDIA_HASH_MISMATCH");
            boolean audio=asset.mimeType().startsWith("audio/");
            entries.add(new ExamMediaImportPlan.Entry(asset.id().toString(),asset.sha256Hash(),asset.mimeType(),Set.of(audio?"PRACTICE_AUDIO":"PRACTICE_IMAGE"),Set.of(audio?"AUDIO":"IMAGE"),
                    asset.validationState(),ExamMediaImportPlan.SourceKind.UNKNOWN,null,Map.of(),asset.objectKey(),asset.sha256Hash(),
                    ExamMediaImportPlan.FileStatus.VERIFIED,true,true,null,false,false));
        }
        return new ExamMediaImportPlan.Plan(pkg.manifest().packageId(),entries,0,true,Map.of());
    }
}
