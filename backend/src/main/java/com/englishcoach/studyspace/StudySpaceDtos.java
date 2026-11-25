package com.englishcoach.studyspace;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Wire shapes of Không gian học tập. Layouts are opaque JSON objects to the server (bounded, never interpreted). */
public final class StudySpaceDtos {

    private StudySpaceDtos() {
    }

    // ── Spaces ──────────────────────────────────────────────────────────────────────────────────────────────
    public record SpaceSummary(UUID id, String name, int position, boolean active, boolean hasDefault,
                               Instant defaultSavedAt, long revision, Instant updatedAt) {
    }

    public record Space(UUID id, String name, int position, boolean active, JsonNode layout, JsonNode defaultLayout,
                        Instant defaultSavedAt, long revision, Instant updatedAt) {
    }

    public record SpaceList(List<SpaceSummary> items, Space active, int limit) {
    }

    public record CreateSpaceRequest(@NotNull @Size(min = 1, max = 60) String name, JsonNode layout, UUID copyFrom,
                                     Boolean activate) {
    }

    public record RenameRequest(@NotNull @Size(min = 1, max = 60) String name) {
    }

    /** reason: NONE (auto-save), CLEAR (Xóa trắng), RESTORE (default / snapshot), TEMPLATE (a system template). */
    public record SaveLayoutRequest(@NotNull JsonNode layout, Long revision, String reason) {
    }

    public record SaveDefaultRequest(@NotNull JsonNode layout) {
    }

    public record Snapshot(UUID id, String kind, String label, Instant createdAt) {
    }

    public record SnapshotDetail(UUID id, String kind, String label, Instant createdAt, JsonNode layout) {
    }

    public record CreateSnapshotRequest(@Size(max = 60) String label, @NotNull JsonNode layout) {
    }

    // ── Tasks ───────────────────────────────────────────────────────────────────────────────────────────────
    public record Task(UUID id, String title, String notes, String status, int priority, LocalDate dueOn, String project,
                       String recurrence, int doneCount, LocalDate lastDoneOn, int position, Instant doneAt,
                       Instant createdAt, Instant updatedAt, int focusedSeconds) {
    }

    public record TaskRequest(@Size(min = 1, max = 200) String title, @Size(max = 4000) String notes, String status,
                              @Min(0) @Max(3) Integer priority, LocalDate dueOn, Boolean clearDue,
                              @Size(max = 60) String project, String recurrence, Integer position) {
    }

    // ── Notes ───────────────────────────────────────────────────────────────────────────────────────────────
    public record Note(UUID id, String kind, String title, String body, String color, boolean pinned,
                       Instant createdAt, Instant updatedAt) {
    }

    public record NoteRequest(String kind, @Size(max = 160) String title, @Size(max = 200000) String body,
                              @Size(max = 16) String color, Boolean pinned) {
    }

    // ── Focus ───────────────────────────────────────────────────────────────────────────────────────────────
    public record FocusReport(@NotNull String mode, @NotNull String status, @Min(0) @Max(43200) int plannedSeconds,
                              @Min(0) @Max(43200) int focusedSeconds, UUID taskId, @Size(max = 80) String label,
                              @Size(max = 40) String subject) {
    }

    public record FocusSession(UUID id, String mode, String status, int plannedSeconds, int focusedSeconds,
                               UUID taskId, String label, String subject, Instant startedAt, Instant endedAt) {
    }

    public record DayTotal(LocalDate day, int focusedSeconds, int completed, int interrupted) {
    }

    public record FocusStats(List<DayTotal> days, int totalSeconds, int completed, int interrupted,
                             Map<String, Integer> bySubject, Map<String, Integer> byTask, int streakDays,
                             List<FocusSession> recent) {
    }

    // ── Research ────────────────────────────────────────────────────────────────────────────────────────────
    public record ResearchItem(UUID id, String title, String authors, Integer year, String venue, String doi, String url,
                               String project, String tags, boolean favorite, String fileName, Long fileSize,
                               int lastPage, JsonNode annotations, String notes, Instant createdAt, Instant updatedAt) {
    }

    public record ResearchRequest(@Size(max = 300) String title, @Size(max = 600) String authors, Integer year,
                                  @Size(max = 300) String venue, @Size(max = 200) String doi,
                                  @Size(max = 1000) String url, @Size(max = 60) String project,
                                  @Size(max = 300) String tags, Boolean favorite, @Size(max = 200) String fileName,
                                  Long fileSize, Integer lastPage, JsonNode annotations,
                                  @Size(max = 50000) String notes) {
    }
}
