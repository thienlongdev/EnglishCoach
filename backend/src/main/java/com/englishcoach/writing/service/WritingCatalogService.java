package com.englishcoach.writing.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.util.*;

@Slf4j
@Service
public class WritingCatalogService {

    public static final int MAX_DYNAMIC_TASKS_PER_USER = 50;
    public static final int MAX_TOTAL_DYNAMIC_TASKS = 2_000;
    public static final long DYNAMIC_TASK_TTL_MILLIS = 60L * 60L * 1000L; // 1 hour

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Getter
    private List<Map<String, Object>> tasks = List.of();
    private Map<String, Map<String, Object>> taskMap = Map.of();

    private record DynamicTaskEntry(Long ownerUserId, String taskId, Map<String, Object> task, long expiresAtMillis) {}

    private final Object dynamicTasksLock = new Object();
    private final Map<Long, LinkedHashMap<String, DynamicTaskEntry>> dynamicTasksByOwner = new HashMap<>();
    private final LinkedHashMap<String, DynamicTaskEntry> dynamicTasksGlobalLru = new LinkedHashMap<>(128, 0.75f, true);

    @Getter
    private List<Map<String, Object>> errorPatterns = List.of();
    private Map<String, Map<String, Object>> errorPatternMap = Map.of();

    @Getter
    private List<Map<String, Object>> skills = List.of();
    private Map<String, Map<String, Object>> skillMap = Map.of();

    @Getter
    private List<Map<String, Object>> exercises = List.of();
    private Map<String, Map<String, Object>> exerciseMap = Map.of();

    @Getter
    private JsonNode policies;

    @PostConstruct
    public void init() {
        loadTasks();
        loadErrorPatterns();
        loadSkills();
        loadPolicies();
        loadExercises();
        log.info("WritingCatalogService initialized with {} tasks, {} error patterns, {} skills, {} exercises",
                tasks.size(), errorPatterns.size(), skills.size(), exercises.size());
    }

    private void loadTasks() {
        try (InputStream is = getClass().getResourceAsStream("/writing/tasks.json")) {
            if (is != null) {
                List<Map<String, Object>> loaded = objectMapper.readValue(is, new TypeReference<>() {});
                List<Map<String, Object>> immutableTasks = new ArrayList<>(loaded.size());
                Map<String, Map<String, Object>> immutableMap = new LinkedHashMap<>(loaded.size());
                for (Map<String, Object> task : loaded) {
                    Map<String, Object> unmodifiableTask = Collections.unmodifiableMap(new LinkedHashMap<>(task));
                    immutableTasks.add(unmodifiableTask);
                    String id = (String) unmodifiableTask.get("id");
                    if (id != null) {
                        immutableMap.put(id, unmodifiableTask);
                    }
                }
                tasks = List.copyOf(immutableTasks);
                taskMap = Map.copyOf(immutableMap);
            }
        } catch (Exception e) {
            log.error("Failed to load /writing/tasks.json", e);
        }
    }

    private void loadErrorPatterns() {
        try (InputStream is = getClass().getResourceAsStream("/writing/error_patterns.json")) {
            if (is != null) {
                List<Map<String, Object>> loaded = objectMapper.readValue(is, new TypeReference<>() {});
                Map<String, Map<String, Object>> map = new LinkedHashMap<>(loaded.size());
                List<Map<String, Object>> list = new ArrayList<>(loaded.size());
                for (Map<String, Object> ep : loaded) {
                    Map<String, Object> unmodifiable = Collections.unmodifiableMap(new LinkedHashMap<>(ep));
                    list.add(unmodifiable);
                    String code = (String) unmodifiable.get("code");
                    if (code != null) {
                        map.put(code, unmodifiable);
                    }
                }
                errorPatterns = List.copyOf(list);
                errorPatternMap = Map.copyOf(map);
            }
        } catch (Exception e) {
            log.error("Failed to load /writing/error_patterns.json", e);
        }
    }

    private void loadSkills() {
        try (InputStream is = getClass().getResourceAsStream("/writing/skills.json")) {
            if (is != null) {
                List<Map<String, Object>> loaded = objectMapper.readValue(is, new TypeReference<>() {});
                Map<String, Map<String, Object>> map = new LinkedHashMap<>(loaded.size());
                List<Map<String, Object>> list = new ArrayList<>(loaded.size());
                for (Map<String, Object> s : loaded) {
                    Map<String, Object> unmodifiable = Collections.unmodifiableMap(new LinkedHashMap<>(s));
                    list.add(unmodifiable);
                    String code = (String) unmodifiable.get("skillCode");
                    if (code != null) {
                        map.put(code, unmodifiable);
                    }
                }
                skills = List.copyOf(list);
                skillMap = Map.copyOf(map);
            }
        } catch (Exception e) {
            log.error("Failed to load /writing/skills.json", e);
        }
    }

    private void loadPolicies() {
        try (InputStream is = getClass().getResourceAsStream("/writing/policies.json")) {
            if (is != null) {
                policies = objectMapper.readTree(is);
            }
        } catch (Exception e) {
            log.error("Failed to load /writing/policies.json", e);
        }
    }

    private void loadExercises() {
        try (InputStream is = getClass().getResourceAsStream("/writing/exercises.json")) {
            if (is != null) {
                JsonNode root = objectMapper.readTree(is);
                JsonNode exNode = root.get("exercises");
                if (exNode != null && exNode.isArray()) {
                    List<Map<String, Object>> loaded = objectMapper.convertValue(exNode, new TypeReference<>() {});
                    Map<String, Map<String, Object>> map = new LinkedHashMap<>(loaded.size());
                    List<Map<String, Object>> list = new ArrayList<>(loaded.size());
                    for (Map<String, Object> ex : loaded) {
                        Map<String, Object> unmodifiable = Collections.unmodifiableMap(new LinkedHashMap<>(ex));
                        list.add(unmodifiable);
                        String id = (String) unmodifiable.get("id");
                        if (id != null) {
                            map.put(id, unmodifiable);
                        }
                    }
                    exercises = List.copyOf(list);
                    exerciseMap = Map.copyOf(map);
                }
            }
        } catch (Exception e) {
            log.error("Failed to load /writing/exercises.json", e);
        }
    }

    /** Returns only a verified static catalog task (never any user-scoped dynamic task). */
    public Optional<Map<String, Object>> getStaticTaskById(String taskId) {
        if (taskId == null || taskId.isBlank()) {
            return Optional.empty();
        }
        return Optional.ofNullable(taskMap.get(taskId));
    }

    /** Whether {@code taskId} belongs to the immutable static writing catalog. */
    public boolean isStaticTask(String taskId) {
        return taskId != null && taskMap.containsKey(taskId);
    }

    /** Unowned lookup returns ONLY immutable static catalog tasks (never leaks another user's dynamic task). */
    public Optional<Map<String, Object>> getTaskById(String taskId) {
        return getStaticTaskById(taskId);
    }

    /**
     * Owner-scoped lookup: checks {@code ownerUserId}'s private dynamic tasks first, then falls back to the immutable
     * static catalog. Another learner's dynamic task is never visible.
     */
    public Optional<Map<String, Object>> getTaskById(Long ownerUserId, String taskId) {
        if (taskId == null || taskId.isBlank()) {
            return Optional.empty();
        }
        if (ownerUserId != null) {
            long now = System.currentTimeMillis();
            synchronized (dynamicTasksLock) {
                LinkedHashMap<String, DynamicTaskEntry> ownerMap = dynamicTasksByOwner.get(ownerUserId);
                if (ownerMap != null) {
                    DynamicTaskEntry entry = ownerMap.get(taskId);
                    if (entry != null) {
                        if (now <= entry.expiresAtMillis()) {
                            // Touch global LRU order
                            dynamicTasksGlobalLru.get(compositeKey(ownerUserId, taskId));
                            return Optional.of(entry.task());
                        }
                        ownerMap.remove(taskId);
                        dynamicTasksGlobalLru.remove(compositeKey(ownerUserId, taskId));
                        if (ownerMap.isEmpty()) {
                            dynamicTasksByOwner.remove(ownerUserId);
                        }
                    }
                }
            }
        }
        return getStaticTaskById(taskId);
    }

    /**
     * Registers a transient dynamic task scoped exclusively to {@code ownerUserId} in a bounded TTL LRU store.
     * Static catalog {@link #tasks} and {@link #taskMap} are immutable and never mutated (EC-SEC-2026-005).
     */
    public void registerDynamicTask(Long ownerUserId, Map<String, Object> task) {
        if (ownerUserId == null || task == null) return;
        Object rawId = task.get("id");
        if (!(rawId instanceof String id) || id.isBlank()) return;
        if (taskMap.containsKey(id)) {
            log.warn("Refusing dynamic task registration attempting to shadow static catalog task id={}", id);
            return;
        }

        Map<String, Object> immutableCopy = Collections.unmodifiableMap(new LinkedHashMap<>(task));
        long now = System.currentTimeMillis();
        DynamicTaskEntry entry = new DynamicTaskEntry(ownerUserId, id, immutableCopy, now + DYNAMIC_TASK_TTL_MILLIS);
        String globalKey = compositeKey(ownerUserId, id);

        synchronized (dynamicTasksLock) {
            evictExpiredLocked(now);
            LinkedHashMap<String, DynamicTaskEntry> ownerMap = dynamicTasksByOwner.computeIfAbsent(
                    ownerUserId, k -> new LinkedHashMap<>(16, 0.75f, true)
            );
            ownerMap.put(id, entry);
            while (ownerMap.size() > MAX_DYNAMIC_TASKS_PER_USER) {
                Iterator<Map.Entry<String, DynamicTaskEntry>> it = ownerMap.entrySet().iterator();
                if (!it.hasNext()) break;
                Map.Entry<String, DynamicTaskEntry> eldest = it.next();
                it.remove();
                dynamicTasksGlobalLru.remove(compositeKey(ownerUserId, eldest.getKey()));
            }

            dynamicTasksGlobalLru.put(globalKey, entry);
            while (dynamicTasksGlobalLru.size() > MAX_TOTAL_DYNAMIC_TASKS) {
                Iterator<Map.Entry<String, DynamicTaskEntry>> it = dynamicTasksGlobalLru.entrySet().iterator();
                if (!it.hasNext()) break;
                DynamicTaskEntry evicted = it.next().getValue();
                it.remove();
                LinkedHashMap<String, DynamicTaskEntry> evictedOwnerMap = dynamicTasksByOwner.get(evicted.ownerUserId());
                if (evictedOwnerMap != null) {
                    evictedOwnerMap.remove(evicted.taskId());
                    if (evictedOwnerMap.isEmpty()) {
                        dynamicTasksByOwner.remove(evicted.ownerUserId());
                    }
                }
            }
        }
    }

    private void evictExpiredLocked(long now) {
        if (dynamicTasksGlobalLru.isEmpty()) return;
        Iterator<Map.Entry<String, DynamicTaskEntry>> it = dynamicTasksGlobalLru.entrySet().iterator();
        while (it.hasNext()) {
            DynamicTaskEntry entry = it.next().getValue();
            if (now > entry.expiresAtMillis()) {
                it.remove();
                LinkedHashMap<String, DynamicTaskEntry> ownerMap = dynamicTasksByOwner.get(entry.ownerUserId());
                if (ownerMap != null) {
                    ownerMap.remove(entry.taskId());
                    if (ownerMap.isEmpty()) {
                        dynamicTasksByOwner.remove(entry.ownerUserId());
                    }
                }
            }
        }
    }

    private static String compositeKey(Long ownerUserId, String taskId) {
        return ownerUserId + ":" + taskId;
    }

    public Optional<Map<String, Object>> getErrorPatternByCode(String code) {
        return Optional.ofNullable(errorPatternMap.get(code));
    }

    public Optional<Map<String, Object>> getSkillByCode(String code) {
        return Optional.ofNullable(skillMap.get(code));
    }

    public Optional<Map<String, Object>> getExerciseById(String id) {
        return Optional.ofNullable(exerciseMap.get(id));
    }

    public List<Map<String, Object>> getExercisesByMode(String mode) {
        return exercises.stream()
                .filter(e -> mode.equalsIgnoreCase((String) e.get("mode")))
                .toList();
    }

    public List<Map<String, Object>> getExercisesByPatternCode(String patternCode) {
        return exercises.stream()
                .filter(e -> patternCode.equals(e.get("pattern_code")))
                .toList();
    }
}
