package com.englishcoach.exams.scoring;

import com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class IeltsWritingTasksTest {
    private static final Map<String, Object> IMAGE = Map.of("assetId", UUID.randomUUID().toString(),
            "role", "CHART_IMAGE", "mimeType", "image/svg+xml");

    private List<Map<String, String>> tasks(Map<String, Object> body, List<?> assets) {
        UUID section = UUID.randomUUID(), item = UUID.randomUUID(), essay = UUID.randomUUID();
        var visual = Map.of("kind", "CHART", "bodyPayload", body, "assets", assets);
        var first = group(item, List.of(visual));
        var second = group(essay, List.of());
        var parts = List.of(Map.of("groups", List.of(first)), Map.of("groups", List.of(second)));
        var snapshot = Map.<String, Object>of("sections", List.of(Map.of("id", section.toString(), "parts", parts)));
        var response = new ResponseRecord(null, null, section, null, item, null, "My response.", null, false, 0, null, null);
        return IeltsWritingTasks.from(snapshot, section, Map.of(item, response, essay, response), "ACADEMIC");
    }

    private Map<String, Object> group(UUID item, List<?> stimuli) {
        return Map.of("stimuli", stimuli, "items", List.of(Map.of("id", item.toString(),
                "interactionType", "writing_response", "prompt", "Describe the information.")));
    }

    @Test
    void forwardsOnlyPinnedAxisLabelsUnitAndDataToTaskOne() {
        var chart = Map.<String, Object>of("title", "Energy", "chartType", "bar_chart", "unit", "USD billions",
                "years", List.of(2015, 2020), "sectors", List.of(Map.of("name", "Solar", "values", List.of(85, 130))),
                "internalNote", "server material");
        var result = tasks(chart, List.of(IMAGE));
        assertEquals(2, result.size());
        assertEquals("Describe the information.\nEnergy (USD billions)\nSector | 2015 | 2020\nSolar | 85 | 130\n",
                result.get(0).get("prompt"));
        assertFalse(result.get(1).get("prompt").contains("Solar"));
    }

    @Test
    void chartWithMissingValuesCaptionOnlyOrExtraUnrepresentedImageAbstains() {
        var chart = new HashMap<String, Object>(Map.of("title", "Energy", "chartType", "bar_chart", "unit", "USD billions",
                "years", List.of(2015, 2020), "sectors", List.of(Map.of("name", "Solar", "values", List.of(85, 130)))));
        assertTrue(tasks(chart, List.of(IMAGE, IMAGE)).isEmpty());
        assertTrue(tasks(chart, List.of()).isEmpty());
        chart.put("sectors", List.of(Map.of("name", "Solar", "values", List.of(85))));
        assertTrue(tasks(chart, List.of(IMAGE)).isEmpty());
        assertTrue(tasks(Map.of("text", "A bar chart"), List.of(IMAGE)).isEmpty());
    }
}
