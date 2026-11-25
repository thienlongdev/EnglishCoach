package com.englishcoach.exams.scoring;

import com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord;
import java.util.*;

/** Two tasks in pinned presentation order, with only learner-visible stimulus text sent to the judge. */
public final class IeltsWritingTasks {
    private IeltsWritingTasks() {}

    private static List<?> children(Map<?, ?> parent, String key) {
        return parent.get(key) instanceof List<?> values ? values : List.of();
    }

    public static List<Map<String, String>> from(Map<String, Object> snapshot, UUID sectionId,
                                                  Map<UUID, ResponseRecord> responses, String variant) {
        if (snapshot == null) return List.of();
        List<Map<String, String>> tasks = new ArrayList<>();
        for (Object section : children(snapshot, "sections")) {
            if (!(section instanceof Map<?, ?> s) || !sectionId.toString().equals(s.get("id"))) continue;
            for (Object part : children(s, "parts")) {
                if (!(part instanceof Map<?, ?> p)) return List.of();
                for (Object group : children(p, "groups")) {
                    if (!(group instanceof Map<?, ?> g)) return List.of();
                    StringBuilder context = new StringBuilder();
                    for (Object stimulus : children(g, "stimuli")) {
                        if (!(stimulus instanceof Map<?, ?> st)) return List.of();
                        List<?> assets = children(st, "assets");
                        if (!assets.isEmpty() || "CHART".equals(st.get("kind"))) {
                            if (!appendChart(context, st, assets)) return List.of();
                            continue;
                        }
                        if (!(st.get("bodyPayload") instanceof Map<?, ?> body)) continue;
                        if (body.get("text") instanceof String t) context.append(t).append('\n');
                        for (Object paragraph : children(body, "paragraphs")) {
                            if (paragraph instanceof Map<?, ?> par && par.get("text") instanceof String t) context.append(t).append('\n');
                        }
                    }
                    for (Object item : children(g, "items")) {
                        if (!(item instanceof Map<?, ?> i) || !"WRITING_RESPONSE".equalsIgnoreCase(Objects.toString(i.get("interactionType"), ""))
                                || !(i.get("prompt") instanceof String prompt) || prompt.isBlank()) return List.of();
                        ResponseRecord response = responses.get(UUID.fromString(String.valueOf(i.get("id"))));
                        if (response == null) return List.of();
                        String answer = response.textResponse();
                        if ((answer == null || answer.isBlank()) && response.answerPayload() != null) {
                            Object value = response.answerPayload().getOrDefault("value", response.answerPayload().get("text"));
                            answer = value instanceof String v ? v : null;
                        }
                        if (answer == null || answer.isBlank()) return List.of();
                        tasks.add(Map.of("taskType", "TASK_" + (tasks.size()+1), "variant", variant,
                                "prompt", prompt + "\n" + context, "response", answer));
                    }
                }
            }
        }
        return tasks.size() == 2 ? List.copyOf(tasks) : List.of();
    }

    /** Read the same chart edition as the learner. Captions alone cannot supply the plotted values. */
    private static boolean appendChart(StringBuilder context, Map<?, ?> stimulus, List<?> assets) {
        if (!"CHART".equals(stimulus.get("kind")) || assets.size() != 1
                || !(assets.get(0) instanceof Map<?, ?> image) || !"CHART_IMAGE".equals(image.get("role"))
                || !(image.get("mimeType") instanceof String mime) || !mime.startsWith("image/")
                || image.get("assetId") == null || !(stimulus.get("bodyPayload") instanceof Map<?, ?> body)
                || !"bar_chart".equals(body.get("chartType"))
                || !(body.get("title") instanceof String title) || title.isBlank()
                || !(body.get("unit") instanceof String unit) || unit.isBlank()) return false;

        List<?> years = children(body, "years");
        List<?> sectors = children(body, "sectors");
        if (years.isEmpty() || sectors.isEmpty() || !years.stream().allMatch(Integer.class::isInstance)
                || new HashSet<>(years).size() != years.size()) return false;
        context.append(title).append(" (").append(unit).append(")\n");
        context.append("Sector | ").append(String.join(" | ", years.stream().map(Object::toString).toList())).append('\n');
        Set<String> names = new HashSet<>();
        for (Object entry : sectors) {
            if (!(entry instanceof Map<?, ?> series) || !(series.get("name") instanceof String name)
                    || name.isBlank() || !names.add(name.strip())) return false;
            List<?> values = children(series, "values");
            if (values.size() != years.size()
                    || !values.stream().allMatch(v -> v instanceof Number n && Double.isFinite(n.doubleValue()))) return false;
            context.append(name).append(" | ").append(String.join(" | ", values.stream().map(Object::toString).toList())).append('\n');
        }
        return true;
    }
}
