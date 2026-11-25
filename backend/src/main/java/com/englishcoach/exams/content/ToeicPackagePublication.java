package com.englishcoach.exams.content;

import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.release.ExamRunnerCapabilities;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.util.*;

/** One normal import and one publication in the same transaction, after the protected admin publish action. */
@Service
@RequiredArgsConstructor
public class ToeicPackagePublication {
    public record Decision(UUID formId, String packageId, int version, String hash, String formHash,
                           String fileHash, String scope, Map<String,Integer> counts) {}
    private static volatile Map<UUID,Decision> decisions = load();
    private static final int MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
    private final ExamContentPackageImporter importer;
    private final ExamContentRepository repository;
    private final ExamObjectStorage storage;
    private final ExamPrivatePackageDrafts mediaVerifier;
    private final ExamContentValidationRepository validation;
    private final ExamRightsService rights;
    private final ExamPermissionService permissions;
    private final ObjectMapper mapper;

    private static Map<UUID,Decision> load() {
        try (var stream = ToeicPackagePublication.class.getResourceAsStream("/exams/toeic-publication-decisions.json")) {
            Decision[] decisions = new ObjectMapper().readValue(stream, Decision[].class);
            Map<UUID,Decision> index = new HashMap<>();
            for (var d : decisions) {
                if (!List.of("READING","FULL","LISTENING").contains(d.scope()) || d.version() < 1
                        || !d.packageId().startsWith("BANK_TOEIC_") || d.counts().isEmpty()
                        || !List.of(d.hash(),d.formHash(),d.fileHash()).stream().allMatch(h -> h.matches("[0-9a-f]{64}"))
                        || index.putIfAbsent(d.formId(),d) != null)
                    throw new IllegalStateException("Invalid TOEIC release index");
            }
            return Map.copyOf(index);
        } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
    }

    public static boolean practiceOnly(UUID id) {
        var d = decisions.get(id);
        return d != null && !"FULL".equals(d.scope());
    }

    public static boolean exactPartSet(UUID id, String partCode, int items) {
        var d = decisions.get(id);
        return d != null && d.counts().size() == 1 && !"FULL".equals(d.scope())
                && Objects.equals(d.counts().get(partCode), items);
    }

    public record SignedDecisions(String payload, String signature) {}

    public List<Decision> pendingDecisions() {
        refreshSignedRoster();
        return decisions.values().stream().sorted(Comparator.comparing(Decision::packageId))
                .filter(d -> repository.findFormById(d.formId()).map(f -> f.lifecycleState()==LifecycleState.DRAFT)
                        .orElse(true)).toList();
    }

    @jakarta.annotation.PostConstruct
    public void loadPublishedRoster() {
        refreshSignedRoster();
    }

    /** A read-only, additive release roster. Keys and signing tools never reside on the server. */
    public synchronized void refreshSignedRoster() {
        String path = "toeic-publication/owner-index.json";
        if (!storage.objectExists(path)) return;
        try (var input = storage.getObjectStream(path);
             var key = ToeicPackagePublication.class.getResourceAsStream("/exams/toeic-publication-public.der")) {
            byte[] envelope = input.readNBytes(MAX_PACKAGE_BYTES+1);
            if (envelope.length > MAX_PACKAGE_BYTES) throw new IllegalArgumentException("Roster too large");
            var signed = mapper.readValue(envelope,SignedDecisions.class);
            byte[] payload = Base64.getDecoder().decode(signed.payload());
            var verifier = Signature.getInstance("Ed25519");
            verifier.initVerify(KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(key.readAllBytes())));
            verifier.update(payload);
            if (!verifier.verify(Base64.getDecoder().decode(signed.signature())))
                throw new IllegalStateException("TOEIC_PUBLICATION_SIGNATURE_INVALID");
            var merged = new HashMap<>(decisions);
            for (var d : mapper.readValue(payload, Decision[].class)) {
                if (!d.packageId().matches("BANK_TOEIC_[A-Z0-9_]+") || d.version()<1 || d.counts().isEmpty()
                        || !Set.of("READING","LISTENING","FULL").contains(d.scope())
                        || !List.of(d.hash(),d.formHash(),d.fileHash()).stream().allMatch(h->h.matches("[0-9a-f]{64}")))
                    throw new IllegalStateException("TOEIC_PUBLICATION_DECISION_INVALID");
                var previous = merged.putIfAbsent(d.formId(),d);
                if (previous!=null && !previous.equals(d)) throw new IllegalStateException("TOEIC_PUBLICATION_DECISION_CONFLICT");
            }
            decisions = Map.copyOf(merged);
        } catch (IOException | java.security.GeneralSecurityException e) {
            throw new IllegalStateException("TOEIC_PUBLICATION_ROSTER_INVALID",e);
        }
    }

    @Transactional
    public boolean publishIfCovered(UUID id, Long actor) {
        if (!decisions.containsKey(id)) refreshSignedRoster();
        var decision = decisions.get(id);
        if (decision == null) return false;
        if (actor == null || !permissions.hasOperatorPermission(actor,"EXAMS_PUBLISH")
                || !permissions.hasOperatorPermission(actor,"EXAMS_AUTHOR"))
            throw new IllegalStateException("CONTENT_PUBLISH_PERMISSION_REQUIRED");
        repository.lockPackageIdentity(decision.packageId(),decision.version());
        var pkg = readPackage(decision);
        for (var asset : pkg.assets()) mediaVerifier.verifyObject(asset);
        var result = importer.importPackage(pkg, actor);
        var form = repository.findFormById(id).orElseThrow();
        if (!id.equals(result.formId()) || !decision.hash().equals(result.contentHash())
                || !decision.formHash().equals(form.contentHash())
                || (form.lifecycleState()!=LifecycleState.DRAFT && form.lifecycleState()!=LifecycleState.PUBLISHED))
            throw new IllegalStateException("TOEIC_PUBLICATION_EDITION_MISMATCH");
        if (!rights.verifyFormRights(id,ExamRightsDecisionPolicy.Operation.PUBLICATION))
            throw new IllegalStateException("RIGHTS_VERIFICATION_FAILED");
        // The new form and its validation receipt must use this transaction. A separate audit
        // transaction cannot see the uncommitted form and would wait for its foreign key.
        var tree = validation.loadTree(id).orElseThrow();
        var report = ExamFormValidator.validate(tree, mapper, Instant.now());
        if (report.contentFingerprint()==null || ("FULL".equals(decision.scope()) && !report.fullSimulationEligible()))
            throw new IllegalStateException("TOEIC_PUBLICATION_VALIDATION_FAILED");
        Map<String,Integer> actual = new TreeMap<>();
        for (var r : ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                new FormFacts(true,true), mapper)) {
            var s = r.scope();
            if (!r.ready() || !s.objectiveScoring() || s.itemCount()!=s.objectiveItemCount()
                    || actual.putIfAbsent(s.partCode(),s.itemCount())!=null)
                throw new IllegalStateException("TOEIC_PUBLICATION_SCOPE_NOT_READY: "+detailedScope(decision,s.scopeCode(),r.reasonCodes()));
        }
        if (!actual.equals(decision.counts())) throw new IllegalStateException("TOEIC_PUBLICATION_SCOPE_MISMATCH");
        if (form.lifecycleState()!=LifecycleState.PUBLISHED) {
            validation.insertValidation(report,"PUBLICATION");
            repository.updateFormLifecycle(id,LifecycleState.PUBLISHED,Instant.now(),null);
            repository.insertAuditEvent(actor,"TOEIC_OWNER_EDITION_PUBLISHED","FORM_VERSION",id.toString(),
                    decision.formHash(),decision.hash(),"Owner-authorized TOEIC "+decision.scope()+"; machine-reviewed. "
                            + "Package bytes "+decision.fileHash()+". No human review recorded.",null);
        }
        return true;
    }

    private static String detailedScope(Decision decision, String code, List<String> reasons) {
        return decision.packageId()+" "+code+" "+reasons;
    }

    private ExamContentPackage readPackage(Decision d) {
        String path = "toeic-publication/packages/"+d.fileHash()+".json";
        try (InputStream input = storage.getObjectStream(path)) {
            byte[] bytes = input.readNBytes(MAX_PACKAGE_BYTES+1);
            if (bytes.length>MAX_PACKAGE_BYTES || !d.fileHash().equals(HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes)))) throw new IllegalStateException("TOEIC_PUBLICATION_BYTES_MISMATCH");
            var pkg = mapper.readValue(bytes, ExamContentPackage.class);
            if (pkg.form().family()!=ExamFamily.TOEIC || !d.formId().equals(pkg.form().id())
                    || !d.scope().equals(pkg.form().scope()) || !d.packageId().equals(pkg.manifest().packageId())
                    || d.version()!=pkg.manifest().packageVersion() || !d.hash().equals(pkg.manifest().contentHash())
                    || pkg.licenses().stream().anyMatch(l -> !"APPROVED".equals(l.legalStatus())))
                throw new IllegalStateException("TOEIC_PUBLICATION_PACKAGE_MISMATCH");
            return pkg;
        } catch (IOException | java.security.NoSuchAlgorithmException ex) {
            throw new IllegalStateException("TOEIC_PUBLICATION_PACKAGE_UNAVAILABLE",ex);
        }
    }
}
