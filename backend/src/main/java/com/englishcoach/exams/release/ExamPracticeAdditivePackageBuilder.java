package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;

/** Local package assembly only. The combined graph must pass the canonical qualification/import gates.
 * Accepted scopes retain their complete immutable dependency graph. No QA decision or lifecycle write occurs.
 */
public final class ExamPracticeAdditivePackageBuilder {
    private ExamPracticeAdditivePackageBuilder() {}

    public static ExamPracticePackageProjection.Result build(ExamContentPackage accepted,
            ExamPracticePackageProjection.Result candidate, ObjectMapper mapper) {
        var fresh = candidate.pkg();
        var oldIdentity = ExamPackageIdentity.of(accepted);
        var newIdentity = ExamPackageIdentity.of(fresh);
        if (!Objects.equals(oldIdentity.sourceKey(), newIdentity.sourceKey())
                || !Objects.equals(accepted.form().logicalKey(), fresh.form().logicalKey()))
            throw new IllegalArgumentException("ADDITIVE_SOURCE_IDENTITY_MISMATCH");
        if (!accepted.formComponents().isEmpty() || !fresh.formComponents().isEmpty())
            throw new IllegalArgumentException("ADDITIVE_COMPONENTS_UNSUPPORTED");
        ObjectNode old = mapper.valueToTree(accepted), incoming = mapper.valueToTree(fresh);
        for (String field : List.of("family", "variant", "scope", "catalogNodeId", "specificationId", "scoringSchemeId", "provenanceId"))
            if (!old.path("form").path(field).equals(incoming.path("form").path(field)))
                throw new IllegalArgumentException("ADDITIVE_FORM_FACT_CHANGED:" + field);
        Set<String> oldParts = new TreeSet<>();
        accepted.parts().forEach(p -> oldParts.add(p.partCode()));
        Set<String> overlap = new TreeSet<>(oldParts);
        overlap.retainAll(fresh.parts().stream().map(p -> p.partCode()).toList());
        for (String part : overlap) {
            var prior = placements(oldIdentity, part);
            var next = placements(newIdentity, part);
            if (!prior.equals(next)) throw new IllegalArgumentException("ADDITIVE_RETAINED_SCOPE_CHANGED:" + part);
        }
        // Remove only equal duplicate scopes from the incoming graph; accepted rows supply their closure.
        Set<String> newPartIds = ids(incoming.path("parts"), n -> !oldParts.contains(n.path("partCode").asText()));
        Set<String> newGroups = refs(incoming.path("formGroups"), "groupId", n -> newPartIds.contains(n.path("partId").asText()));
        Set<String> newItems = ids(incoming.path("items"), n -> newGroups.contains(n.path("groupId").asText()));
        Set<String> newStimuli = refs(incoming.path("groupStimuli"), "stimulusId", n -> newGroups.contains(n.path("groupId").asText()));
        Set<String> newAssets = refs(incoming.path("stimulusAssets"), "assetId", n -> newStimuli.contains(n.path("stimulusId").asText()));
        filter(incoming,"parts",n -> newPartIds.contains(n.path("id").asText()));
        filter(incoming,"formGroups",n -> newPartIds.contains(n.path("partId").asText()));
        filter(incoming,"groups",n -> newGroups.contains(n.path("id").asText()));
        filter(incoming,"items",n -> newItems.contains(n.path("id").asText()));
        filter(incoming,"answerSpecs",n -> newItems.contains(n.path("itemId").asText()));
        filter(incoming,"groupStimuli",n -> newGroups.contains(n.path("groupId").asText()));
        filter(incoming,"stimuli",n -> newStimuli.contains(n.path("id").asText()));
        filter(incoming,"stimulusAssets",n -> newStimuli.contains(n.path("stimulusId").asText()));
        filter(incoming,"assets",n -> newAssets.contains(n.path("id").asText()));
        Set<String> newSections = refs(incoming.path("parts"),"sectionId",n -> true);
        filter(incoming,"sections",n -> newSections.contains(n.path("id").asText()));

        Map<String,JsonNode> sections = new LinkedHashMap<>();
        for (JsonNode n : old.path("sections")) sections.put(sectionKey(n),n);
        for (JsonNode n : incoming.path("sections")) {
            JsonNode prior = sections.get(sectionKey(n));
            if (prior != null) {
                if (!without(prior,"id","formId","ordinal").equals(without(n,"id","formId","ordinal")))
                    throw new IllegalArgumentException("ADDITIVE_SECTION_FACT_CHANGED");
                for (JsonNode part : incoming.path("parts")) if (part.path("sectionId").equals(n.path("id")))
                    ((ObjectNode)part).set("sectionId",prior.path("id"));
            } else {
                ((ObjectNode)n).set("formId",old.path("form").path("id"));
                sections.put(sectionKey(n),n);
            }
        }
        ArrayNode mergedSections = mapper.createArrayNode();
        List<String> skills = List.of("LISTENING","READING","WRITING","SPEAKING");
        sections.values().stream().sorted(Comparator.comparingInt(n -> skills.indexOf(n.path("skill").asText())))
                .forEach(n -> { ((ObjectNode)n).put("ordinal",mergedSections.size()+1); mergedSections.add(n); });
        old.set("sections",mergedSections);
        List<Map<String,String>> informationalConflicts = new ArrayList<>();
        for (String array : List.of("sources","licenses","provenances","catalogNodes","specifications","rubrics","calibrations",
                "scoringSchemes","parts","groups","formGroups","stimuli","groupStimuli","items","answerSpecs","assets","stimulusAssets")) {
            Map<String,JsonNode> rows = new LinkedHashMap<>();
            for (JsonNode n : old.path(array)) rows.put(n.path("id").asText(),n);
            for (JsonNode n : incoming.path(array)) {
                JsonNode prior = rows.get(n.path("id").asText());
                if (prior != null && !prior.equals(n)) {
                    if (!array.equals("sources") || !sameSourceExceptPrimaryDocument(prior,n))
                        throw new IllegalArgumentException("ADDITIVE_SHARED_DEFINITION_CHANGED:" + array);
                    informationalConflicts.add(Map.of("sourceId",n.path("id").asText(),
                            "retainedPrimaryDocument",prior.path("referenceMeta").path("primaryDocument").asText(),
                            "incomingPrimaryDocument",n.path("referenceMeta").path("primaryDocument").asText()));
                } else if (prior == null) rows.put(n.path("id").asText(),n);
            }
            ArrayNode merged = mapper.createArrayNode(); rows.values().forEach(merged::add); old.set(array,merged);
        }
        for (JsonNode section : old.path("sections")) {
            List<JsonNode> parts = new ArrayList<>();
            old.path("parts").forEach(p -> { if(p.path("sectionId").equals(section.path("id"))) parts.add(p); });
            parts.sort(Comparator.comparing(p -> p.path("partCode").asText()));
            for(int i=0;i<parts.size();i++) ((ObjectNode)parts.get(i)).put("ordinal",i+1);
        }
        Set<String> scopes = new TreeSet<>(candidate.retainedScopes());
        JsonNode retained = old.path("manifest").path("metadata").path("practiceProjection").path("retainedScopes");
        if (!retained.isArray() || retained.isEmpty()) throw new IllegalArgumentException("ADDITIVE_ACCEPTED_SCOPES_REQUIRED");
        retained.forEach(n -> scopes.add(n.asText()));
        Map<String,List<String>> excluded = new TreeMap<>(candidate.excludedScopes());
        scopes.forEach(excluded::remove);
        old.set("manifest",incoming.path("manifest"));
        ObjectNode meta = (ObjectNode)old.path("manifest").path("metadata");
        meta.set("practiceAdditive",mapper.valueToTree(Map.of("version","exam-practice-additive-v1",
                "acceptedHash",accepted.manifest().contentHash(),"candidateHash",fresh.manifest().contentHash(),
                "retainedScopes",scopes,"sourceReferenceReconciliation",informationalConflicts,
                "humanApprovalCreated",false,"fullSimulationGranted",false)));
        ((ObjectNode)meta.path("practiceProjection")).set("retainedScopes",mapper.valueToTree(scopes));
        ((ObjectNode)meta.path("practiceProjection")).set("excludedScopes",mapper.valueToTree(excluded));
        try {
            var pkg = mapper.treeToValue(old,ExamContentPackage.class);
            ((ObjectNode)old.path("manifest")).put("contentHash",new ExamContentPackageValidator(mapper).computeContentHash(pkg));
            pkg = mapper.treeToValue(old,ExamContentPackage.class);
            var resultIdentity = ExamPackageIdentity.of(pkg);
            for (String part : oldParts) if (!placements(oldIdentity,part).equals(placements(resultIdentity,part)))
                throw new IllegalStateException("ADDITIVE_ACCEPTED_GRAPH_CHANGED");
            return new ExamPracticePackageProjection.Result(pkg,Collections.unmodifiableSet(scopes),Collections.unmodifiableMap(excluded));
        } catch (IllegalStateException e) { throw e; }
        catch (Exception e) { throw new IllegalStateException("ADDITIVE_PACKAGE_SEAL_FAILED",e); }
    }

    private static Map<String,Object> placements(ExamPackageIdentity identity,String part) {
        Map<String,Object> result = new TreeMap<>();
        identity.placements().forEach((k,v) -> { if(k.startsWith(part+"#")) result.put(k,v.get("digest")); });
        return result;
    }
    private static String sectionKey(JsonNode n) { return n.path("skill").asText()+":"+n.path("specSectionKey").asText(); }
    private static ObjectNode without(JsonNode n,String... fields) { ObjectNode copy=n.deepCopy(); copy.remove(List.of(fields)); return copy; }
    private static boolean sameSourceExceptPrimaryDocument(JsonNode a,JsonNode b) {
        ObjectNode x=a.deepCopy(),y=b.deepCopy();
        if (!x.path("referenceMeta").isObject() || !y.path("referenceMeta").isObject()) return false;
        for(ObjectNode n:List.of(x,y)) {
            if(!n.path("referenceMeta").path("primaryDocument").asText().startsWith("imports/source-files/")) return false;
            ((ObjectNode)n.path("referenceMeta")).remove("primaryDocument");
        }
        return x.equals(y);
    }
    private static Set<String> ids(JsonNode rows,java.util.function.Predicate<JsonNode> keep) { return refs(rows,"id",keep); }
    private static Set<String> refs(JsonNode rows,String field,java.util.function.Predicate<JsonNode> keep) {
        Set<String> out=new HashSet<>(); rows.forEach(n -> { if(keep.test(n)) out.add(n.path(field).asText()); }); return out;
    }
    private static void filter(ObjectNode root,String field,java.util.function.Predicate<JsonNode> keep) {
        ArrayNode out=root.arrayNode(); root.path(field).forEach(n -> { if(keep.test(n)) out.add(n); }); root.set(field,out);
    }
}
