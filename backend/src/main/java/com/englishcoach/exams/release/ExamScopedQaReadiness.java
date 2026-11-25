package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import com.englishcoach.exams.validation.ExamContentTree;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import java.util.regex.*;

/** Read-only QA attribution for independent Practice candidates. Never an approval or import permission.
 * Unknown/stale attribution fails closed; exact question, explicit unit and crop bindings localize known entries.
 */
public final class ExamScopedQaReadiness {
    private ExamScopedQaReadiness() {}
    public record ScopeQa(boolean ready, List<String> entryIds, List<String> reasonCodes) {}
    public record Result(Map<String, ScopeQa> scopes, List<String> unresolvedEntryIds, List<String> unreferencedCropEntryIds,
                         List<String> unreferencedScopeEntryIds) {}

    public static Result evaluate(ExamContentPackage pkg, ExamContentTree tree, List<ScopeReadiness> scopes,
                                  boolean packageKnown, List<Map<String, Object>> entries, ObjectMapper mapper) {
        Map<String, Set<String>> hits = new TreeMap<>();
        Map<String, Set<String>> reasons = new TreeMap<>();
        Map<String, Set<String>> questionScopes = new HashMap<>(), cropScopes = new HashMap<>();
        for (var scope : scopes) {
            String code = scope.scope().scopeCode();
            hits.put(code, new TreeSet<>()); reasons.put(code, new TreeSet<>());
            if (!packageKnown) reasons.get(code).add("QA_PACKAGE_NOT_REVIEWED");
            for (var section : tree.sections()) for (var part : section.parts()) {
                if (!part.id().equals(scope.scope().partId())) continue;
                for (var group : part.groups()) {
                    for (var item : group.items()) {
                        try {
                            Map<?, ?> defs = mapper.readValue(item.optionDefinitionsJson(), Map.class);
                            if (defs.get("questionNumber") instanceof Number number)
                                questionScopes.computeIfAbsent(section.skill().name() + ":" + number.intValue(), k -> new TreeSet<>()).add(code);
                        } catch (Exception ignored) { /* unresolved entries below fail closed */ }
                    }
                    for (var stimulus : group.stimuli()) for (var asset : stimulus.assets()) {
                        pkg.assets().stream().filter(a -> a.id().equals(asset.id()) && a.sha256Hash() != null).forEach(a ->
                                cropScopes.computeIfAbsent(a.sha256Hash().toLowerCase(Locale.ROOT), k -> new TreeSet<>()).add(code));
                    }
                }
            }
        }
        List<String> unresolved = new ArrayList<>();
        List<String> unreferencedCrops = new ArrayList<>();
        List<String> unreferencedScopes = new ArrayList<>();
        for (Map<String, Object> entry : entries) {
            String priority = String.valueOf(entry.get("releasePriority"));
            String status = String.valueOf(entry.get("status"));
            if (!ExamReleaseReadinessGate.QaStatus.BLOCKING.contains(priority)) continue;
            if (Set.of("APPROVED", "CORRECTED", "RESOLVED_BY_PROOF").contains(status)) continue;
            if ("OWNER_APPROVED_TECHNICAL_MEDIA".equals(status) && "IMAGE_CROP".equals(entry.get("type"))
                    && "TECHNICALLY_VALID".equals(entry.get("cropTechnical"))
                    && com.englishcoach.exams.content.ExamPackageSourceProvenance.fromManifest(pkg.manifest())
                    .map(p -> Set.of("ybm", "economy").contains(p.collection())).orElse(false)) continue;
            String id = String.valueOf(entry.get("id"));
            Set<String> affected = new TreeSet<>();
            boolean stale = !Objects.equals(pkg.manifest().contentHash(), entry.get("packageContentHash"))
                    || !Objects.equals(pkg.manifest().packageId(), entry.get("packageId"));
            // The extractor may render intermediate page regions that are never placed in the final graph.
            // Exact current package identity + absence of the crop from all canonical assets is a dependency proof,
            // not an approval of that image. Missing required images remain blocked by structural readiness.
            if (!stale && "PAGE_REGION_RENDERING".equals(entry.get("subtype"))
                    && entry.get("cropSha256") instanceof String crop && crop.matches("[0-9a-fA-F]{64}")
                    && pkg.assets().stream().noneMatch(a -> crop.equalsIgnoreCase(a.sha256Hash()))) {
                unreferencedCrops.add(id);
                continue;
            }
            String scope = String.valueOf(entry.get("scope")).toUpperCase(Locale.ROOT);
            Set<Integer> numbers = questionNumbers(entry.get("questions"));
            Matcher wholeSkill = Pattern.compile("(?:ANSWER_KEY/)?(LISTENING|READING|WRITING|SPEAKING)").matcher(scope);
            if (wholeSkill.matches()) {
                String skill = wholeSkill.group(1);
                boolean cropBound = entry.get("cropSha256") instanceof String sha && cropScopes.containsKey(sha.toLowerCase(Locale.ROOT));
                if (!stale && numbers != null && !cropBound && tree.sections().stream().noneMatch(s -> s.skill().name().equals(skill))) {
                    // The recorded key belongs to a skill absent from the retained graph. No approval is created.
                    unreferencedScopes.add(id);
                    continue;
                }
                if (numbers != null && numbers.isEmpty())
                    for (var candidate : scopes) if (candidate.scope().skill().name().equals(skill)) affected.add(candidate.scope().scopeCode());
            }
            if (numbers != null && !numbers.isEmpty()) {
                List<String> skills = scope.contains("LISTENING") ? List.of("LISTENING")
                        : scope.contains("READING") ? List.of("READING")
                        : scope.contains("WRITING") ? List.of("WRITING") : List.of("LISTENING", "READING");
                for (String skill : skills) for (int number : numbers)
                    affected.addAll(questionScopes.getOrDefault(skill + ":" + number, Set.of()));
            }
            Matcher explicit = Pattern.compile("(LISTENING|READING|WRITING|SPEAKING)/(?:PART|SECTION|PASSAGE|TASK)_([1-9][0-9]*)(?:/[^\\r\\n]+)?").matcher(scope);
            if (explicit.matches()) {
                String skill = explicit.group(1); int number = Integer.parseInt(explicit.group(2));
                for (var candidate : scopes) if (candidate.scope().skill().name().equals(skill) && candidate.scope().number() == number)
                    affected.add(candidate.scope().scopeCode());
                // An exact current QA unit for a part absent from the canonical graph cannot affect a retained
                // part. Keep that unit excluded; neither approve it nor infer that the missing part is ready.
                String partCode = skill + "_" + scope.substring(scope.indexOf('/') + 1).split("/", 2)[0];
                boolean partPresent = tree.sections().stream().filter(s -> s.skill().name().equals(skill))
                        .flatMap(s -> s.parts().stream()).anyMatch(p -> partCode.equals(p.partCode()));
                boolean validUnit = tree.family().name().equals("TOEIC")
                        ? scope.startsWith(skill + "/PART_") && ((skill.equals("LISTENING") && number <= 4)
                            || (skill.equals("READING") && number >= 5 && number <= 7))
                        : (skill.equals("LISTENING") && scope.startsWith("LISTENING/PART_") && number <= 4)
                            || (skill.equals("READING") && scope.startsWith("READING/PASSAGE_") && number <= 3)
                            || (skill.equals("WRITING") && scope.startsWith("WRITING/TASK_") && number <= 2)
                            || (skill.equals("SPEAKING") && scope.startsWith("SPEAKING/PART_") && number <= 3);
                boolean cropBound = entry.get("cropSha256") instanceof String sha && cropScopes.containsKey(sha.toLowerCase(Locale.ROOT));
                if (!stale && numbers != null && validUnit && !partPresent && affected.isEmpty() && !cropBound) {
                    unreferencedScopes.add(id);
                    continue;
                }
            }
            if (entry.get("cropSha256") instanceof String sha)
                affected.addAll(cropScopes.getOrDefault(sha.toLowerCase(Locale.ROOT), Set.of()));
            boolean uncertain = stale || affected.isEmpty() || numbers == null;
            if (uncertain) {
                unresolved.add(id);
                affected.addAll(hits.keySet());
            }
            for (String code : affected) {
                hits.get(code).add(id);
                reasons.get(code).add(stale ? "QA_ENTRY_STALE" : uncertain ? "QA_ENTRY_SCOPE_UNRESOLVED" : "QA_SCOPE_PENDING");
            }
        }
        Map<String, ScopeQa> result = new TreeMap<>();
        for (String code : hits.keySet()) result.put(code,
                new ScopeQa(reasons.get(code).isEmpty(), List.copyOf(hits.get(code)), List.copyOf(reasons.get(code))));
        return new Result(Collections.unmodifiableMap(result), List.copyOf(unresolved), List.copyOf(unreferencedCrops), List.copyOf(unreferencedScopes));
    }

    /** Printed numbers accept comma/semicolon lists and bounded ranges; malformed input never partially maps. */
    public static Set<Integer> questionNumbers(Object value) {
        if (value == null) return Set.of();
        String text = String.valueOf(value).trim();
        if (text.isEmpty()) return Set.of();
        Set<Integer> out = new TreeSet<>();
        for (String token : text.split("[,;&]", -1)) {
            Matcher match = Pattern.compile("\\s*([1-9][0-9]{0,2})(?:\\s*[-–]\\s*([1-9][0-9]{0,2}))?\\s*").matcher(token);
            if (!match.matches()) return null;
            int start = Integer.parseInt(match.group(1)), end = match.group(2) == null ? start : Integer.parseInt(match.group(2));
            if (end < start || end > 200) return null;
            for (int n = start; n <= end; n++) out.add(n);
        }
        return Collections.unmodifiableSet(out);
    }
}
