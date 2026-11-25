package com.englishcoach.writing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.InputStream;

import static org.junit.jupiter.api.Assertions.*;

public class WritingCatalogsAndContractsTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void testTasksCatalogLoadsAndIsValid() throws Exception {
        try (InputStream is = getClass().getResourceAsStream("/writing/tasks.json")) {
            assertNotNull(is, "tasks.json should be present on classpath");
            JsonNode root = objectMapper.readTree(is);
            assertTrue(root.isArray(), "tasks.json should be a JSON array");
            assertTrue(root.size() >= 4, "Should have at least 4 tasks");

            for (JsonNode task : root) {
                assertNotNull(task.get("id").asText());
                assertNotNull(task.get("category").asText());
                assertNotNull(task.get("title").asText());
                assertNotNull(task.get("prompt").asText());
                assertTrue(task.get("targetWordCountMin").asInt() > 0);
                assertTrue(task.get("targetWordCountMax").asInt() >= task.get("targetWordCountMin").asInt());
                assertTrue(task.get("requirements").isArray());
                assertTrue(task.get("requirements").size() > 0);
            }
        }
    }

    @Test
    void testErrorPatternsCatalogLoadsAndIsValid() throws Exception {
        try (InputStream is = getClass().getResourceAsStream("/writing/error_patterns.json")) {
            assertNotNull(is, "error_patterns.json should be present on classpath");
            JsonNode root = objectMapper.readTree(is);
            assertTrue(root.isArray(), "error_patterns.json should be a JSON array");
            assertTrue(root.size() >= 6, "Should have at least 6 canonical patterns");

            for (JsonNode pattern : root) {
                String code = pattern.get("code").asText();
                assertFalse(code.isEmpty());
                assertNotNull(pattern.get("category").asText());
                assertNotNull(pattern.get("title").asText());
                assertNotNull(pattern.get("explanation").asText());
                assertNotNull(pattern.get("teachingRule").asText());
                assertNotNull(pattern.get("defaultPracticeMode").asText());
                assertNotNull(pattern.get("skillCode").asText());
            }
        }
    }

    @Test
    void testSkillsCatalogLoadsAndIsValid() throws Exception {
        try (InputStream is = getClass().getResourceAsStream("/writing/skills.json")) {
            assertNotNull(is, "skills.json should be present on classpath");
            JsonNode root = objectMapper.readTree(is);
            assertTrue(root.isArray(), "skills.json should be a JSON array");
            assertTrue(root.size() >= 5, "Should have at least 5 skills");

            for (JsonNode skill : root) {
                assertNotNull(skill.get("skillCode").asText());
                assertNotNull(skill.get("category").asText());
                assertNotNull(skill.get("name").asText());
                assertNotNull(skill.get("description").asText());
            }
        }
    }

    @Test
    void testPoliciesCatalogLoadsAndIsValid() throws Exception {
        try (InputStream is = getClass().getResourceAsStream("/writing/policies.json")) {
            assertNotNull(is, "policies.json should be present on classpath");
            JsonNode root = objectMapper.readTree(is);
            assertEquals(1, root.get("policyVersion").asInt());
            assertEquals(3, root.get("recurrence").get("minOccurrences").asInt());
            assertEquals(2, root.get("recurrence").get("minIndependentContexts").asInt());
            assertEquals(4, root.get("prioritization").get("maxInitialPriorityIssues").asInt());
            assertEquals(2000, root.get("limits").get("maxSentenceLengthChars").asInt());
            assertEquals(2000, root.get("limits").get("maxDraftWordCount").asInt());
        }
    }
}
