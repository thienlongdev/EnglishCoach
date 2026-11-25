package com.englishcoach.studyspace;

import com.englishcoach.studyspace.StudySpaceDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

/**
 * The study tools of Không gian học tập: tasks, notes, focus sessions and research metadata. One record per thing, shown
 * by every widget, window or room object that refers to it; removing a widget from a space never deletes the record.
 * Focus time is the server's: it takes the start from its own clock and never stores more focused time than has passed.
 */
@Service
public class StudyToolsService {

    static final int MAX_TASKS = 500;
    static final int MAX_NOTES = 400;
    static final int MAX_RESEARCH = 300;
    static final int NOTE_TEXT_LIMIT = 20_000;
    static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    private static final Set<String> TASK_STATUS = Set.of("OPEN", "DOING", "DONE");
    private static final Set<String> RECURRENCE = Set.of("NONE", "DAILY", "WEEKLY");
    private static final Set<String> NOTE_COLORS = Set.of("sun", "rose", "mint", "sky", "lilac", "sand");
    private static final Set<String> FOCUS_MODES = Set.of("POMODORO", "COUNTDOWN", "STOPWATCH");
    private static final Set<String> FOCUS_STATUS = Set.of("RUNNING", "COMPLETED", "INTERRUPTED");
    /** A running session that has not reported for this long was left (tab closed, device asleep). */
    private static final Duration STALE_RUNNING = Duration.ofMinutes(30);

    private final StudyToolsRepository tools;

    public StudyToolsService(StudyToolsRepository tools) {
        this.tools = tools;
    }

    // ── Tasks ───────────────────────────────────────────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<Task> tasks(long userId) {
        return tools.tasks(userId);
    }

    @Transactional
    public Task createTask(long userId, TaskRequest r) {
        if (tools.count("study_tasks", userId) >= MAX_TASKS) throw new StudySpaceException(409, "TASK_LIMIT");
        String title = required(r.title(), 200);
        String status = r.status() == null ? "OPEN" : oneOf(r.status(), TASK_STATUS);
        UUID id = UUID.randomUUID();
        tools.insertTask(userId, id, title, blankToNull(r.notes()), status, r.priority() == null ? 0 : r.priority(), r.dueOn(),
                blankToNull(r.project()), r.recurrence() == null ? "NONE" : oneOf(r.recurrence(), RECURRENCE),
                r.position() == null ? tools.nextTaskPosition(userId) : r.position());
        return tools.task(userId, id).orElseThrow();
    }

    /**
     * Applies the given fields. Completing a recurring task counts the completion and moves it to its next due day
     * (it stays open): that is the habit tracker.
     */
    @Transactional
    public Task updateTask(long userId, UUID id, TaskRequest r) {
        Task t = tools.task(userId, id).orElseThrow(StudyToolsService::notFound);
        String status = r.status() == null ? t.status() : oneOf(r.status(), TASK_STATUS);
        String recurrence = r.recurrence() == null ? t.recurrence() : oneOf(r.recurrence(), RECURRENCE);
        LocalDate due = Boolean.TRUE.equals(r.clearDue()) ? null : r.dueOn() != null ? r.dueOn() : t.dueOn();
        int doneCount = t.doneCount();
        LocalDate lastDone = t.lastDoneOn();
        Instant doneAt = t.doneAt();
        if ("DONE".equals(status) && !"DONE".equals(t.status())) {
            LocalDate today = LocalDate.now(ZONE);
            doneCount++;
            lastDone = today;
            if (!"NONE".equals(recurrence)) {
                LocalDate base = due == null || due.isBefore(today) ? today : due;
                due = base.plusDays("DAILY".equals(recurrence) ? 1 : 7);
                status = "OPEN";
                doneAt = null;
            } else {
                doneAt = Instant.now();
            }
        } else if (!"DONE".equals(status)) {
            doneAt = null;
        }
        Task next = new Task(id, r.title() == null ? t.title() : required(r.title(), 200),
                r.notes() == null ? t.notes() : blankToNull(r.notes()), status,
                r.priority() == null ? t.priority() : r.priority(), due,
                r.project() == null ? t.project() : blankToNull(r.project()), recurrence, doneCount, lastDone,
                r.position() == null ? t.position() : r.position(), doneAt, t.createdAt(), t.updatedAt(), t.focusedSeconds());
        tools.updateTask(userId, next);
        return tools.task(userId, id).orElseThrow();
    }

    @Transactional
    public void deleteTask(long userId, UUID id) {
        if (!tools.deleteTask(userId, id)) throw notFound();
    }

    // ── Notes ───────────────────────────────────────────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<Note> notes(long userId) {
        return tools.notes(userId);
    }

    @Transactional
    public Note createNote(long userId, NoteRequest r) {
        if (tools.count("study_notes", userId) >= MAX_NOTES) throw new StudySpaceException(409, "NOTE_LIMIT");
        String kind = r.kind() == null ? "NOTE" : oneOf(r.kind(), Set.of("NOTE", "BOARD"));
        UUID id = UUID.randomUUID();
        tools.insertNote(userId, id, kind, trimTo(r.title(), 160), body(kind, r.body()),
                r.color() == null ? "sun" : oneOf(r.color(), NOTE_COLORS), Boolean.TRUE.equals(r.pinned()));
        return tools.note(userId, id).orElseThrow();
    }

    @Transactional
    public Note updateNote(long userId, UUID id, NoteRequest r) {
        Note n = tools.note(userId, id).orElseThrow(StudyToolsService::notFound);
        Note next = new Note(id, n.kind(), r.title() == null ? n.title() : trimTo(r.title(), 160),
                r.body() == null ? n.body() : body(n.kind(), r.body()),
                r.color() == null ? n.color() : oneOf(r.color(), NOTE_COLORS),
                r.pinned() == null ? n.pinned() : r.pinned(), n.createdAt(), n.updatedAt());
        tools.updateNote(userId, next);
        return tools.note(userId, id).orElseThrow();
    }

    @Transactional
    public void deleteNote(long userId, UUID id) {
        if (!tools.deleteNote(userId, id)) throw notFound();
    }

    private static String body(String kind, String body) {
        String b = body == null ? "" : body;
        if ("NOTE".equals(kind) && b.length() > NOTE_TEXT_LIMIT) throw new StudySpaceException(413, "NOTE_TOO_LARGE");
        return b;
    }

    // ── Focus ───────────────────────────────────────────────────────────────────────────────────────────────
    /**
     * One idempotent report per change of a session (start, minute heartbeat, pause, end). The first report of an id
     * creates the row with the server's start time (now minus the time already focused); later reports may only add
     * focused time up to the server's elapsed time; an ended session is final and every repeat returns it unchanged.
     * A COMPLETED claim for a timed session whose time did not pass on the server clock is stored as INTERRUPTED.
     */
    @Transactional
    public FocusSession reportFocus(long userId, UUID id, FocusReport r) {
        String mode = oneOf(r.mode(), FOCUS_MODES);
        String status = oneOf(r.status(), FOCUS_STATUS);
        if (r.taskId() != null && !tools.ownsTask(userId, r.taskId())) throw new StudySpaceException(404, "TASK_NOT_FOUND");
        Optional<long[]> owner = tools.focusOwner(id);
        if (owner.isPresent() && owner.get()[0] != userId) throw notFound();
        Instant now = tools.now();
        String label = trimTo(r.label(), 80);
        String subject = trimTo(r.subject(), 40);
        if (owner.isEmpty()) {
            int focused = 0; // The first server observation cannot attest any earlier client-only time.
            String finalStatus = settle(mode, status, r.plannedSeconds(), focused);
            tools.insertFocus(userId, id, mode, finalStatus, r.plannedSeconds(), focused, r.taskId(), blankToNull(label),
                    blankToNull(subject), now, "RUNNING".equals(finalStatus) ? null : now);
            return tools.focus(userId, id).orElseThrow();
        }
        FocusSession stored = tools.focus(userId, id).orElseThrow();
        if (!"RUNNING".equals(stored.status())) return stored;
        long elapsed = Duration.between(stored.startedAt(), now).getSeconds() + 5;
        int focused = (int) Math.max(stored.focusedSeconds(), Math.min(r.focusedSeconds(), Math.min(elapsed, 43_200)));
        String finalStatus = settle(stored.mode(), status, stored.plannedSeconds(), focused);
        tools.updateFocus(userId, id, finalStatus, focused, r.taskId(), blankToNull(label), blankToNull(subject),
                "RUNNING".equals(finalStatus) ? null : now);
        return tools.focus(userId, id).orElseThrow();
    }

    private static String settle(String mode, String status, int planned, int focused) {
        if ("COMPLETED".equals(status) && !"STOPWATCH".equals(mode) && focused < planned - 30) return "INTERRUPTED";
        return status;
    }

    @Transactional(readOnly = true)
    public FocusStats focusStats(long userId, int days) {
        int span = Math.max(1, Math.min(days, 90));
        LocalDate today = LocalDate.now(ZONE);
        LocalDate first = today.minusDays(span - 1L);
        Instant from = first.atStartOfDay(ZONE).toInstant();
        Instant now = Instant.now();
        List<FocusSession> sessions = tools.focusSince(userId, from, 3000).stream().map(s -> stale(s, now)).toList();
        Map<LocalDate, int[]> byDay = new TreeMap<>();
        for (LocalDate d = first; !d.isAfter(today); d = d.plusDays(1)) byDay.put(d, new int[3]);
        Map<String, Integer> bySubject = new LinkedHashMap<>();
        Map<String, Integer> byTask = new LinkedHashMap<>();
        int total = 0, completed = 0, interrupted = 0;
        for (FocusSession s : sessions) {
            int[] bucket = byDay.get(s.startedAt().atZone(ZONE).toLocalDate());
            if (bucket == null) continue;
            bucket[0] += s.focusedSeconds();
            total += s.focusedSeconds();
            if ("COMPLETED".equals(s.status())) { bucket[1]++; completed++; }
            if ("INTERRUPTED".equals(s.status())) { bucket[2]++; interrupted++; }
            if (s.subject() != null) bySubject.merge(s.subject(), s.focusedSeconds(), Integer::sum);
            if (s.taskId() != null) byTask.merge(s.taskId().toString(), s.focusedSeconds(), Integer::sum);
        }
        List<DayTotal> totals = byDay.entrySet().stream()
                .map(e -> new DayTotal(e.getKey(), e.getValue()[0], e.getValue()[1], e.getValue()[2])).toList();
        return new FocusStats(totals, total, completed, interrupted, bySubject, byTask, streak(userId, today),
                sessions.stream().limit(20).toList());
    }

    /** A running row nobody reported for a long time is shown as interrupted (the stored row is not rewritten here). */
    private static FocusSession stale(FocusSession s, Instant now) {
        if (!"RUNNING".equals(s.status())) return s;
        Instant lastPossible = s.startedAt().plusSeconds(s.focusedSeconds());
        if (Duration.between(lastPossible, now).compareTo(STALE_RUNNING) < 0) return s;
        return new FocusSession(s.id(), s.mode(), "INTERRUPTED", s.plannedSeconds(), s.focusedSeconds(), s.taskId(), s.label(),
                s.subject(), s.startedAt(), lastPossible);
    }

    private int streak(long userId, LocalDate today) {
        List<LocalDate> days = tools.focusDays(userId, 400);
        int streak = 0;
        LocalDate expect = days.contains(today) ? today : today.minusDays(1);
        for (LocalDate d : days) {
            if (d.isAfter(expect)) continue;
            if (!d.equals(expect)) break;
            streak++;
            expect = expect.minusDays(1);
        }
        return streak;
    }

    // ── Research ────────────────────────────────────────────────────────────────────────────────────────────
    @Transactional(readOnly = true)
    public List<ResearchItem> research(long userId) {
        return tools.research(userId);
    }

    @Transactional
    public ResearchItem createResearch(long userId, ResearchRequest r) {
        if (tools.count("study_research_items", userId) >= MAX_RESEARCH) throw new StudySpaceException(409, "RESEARCH_LIMIT");
        UUID id = UUID.randomUUID();
        ResearchItem item = merge(new ResearchItem(id, null, null, null, null, null, null, null, null, false, null, null, 1,
                JsonNodeFactory.instance.arrayNode(), "", null, null), r);
        if (item.title() == null) throw new StudySpaceException(400, "INVALID_TITLE");
        tools.upsertResearch(userId, item, true);
        return tools.research(userId, id).orElseThrow();
    }

    @Transactional
    public ResearchItem updateResearch(long userId, UUID id, ResearchRequest r) {
        ResearchItem current = tools.research(userId, id).orElseThrow(StudyToolsService::notFound);
        tools.upsertResearch(userId, merge(current, r), false);
        return tools.research(userId, id).orElseThrow();
    }

    @Transactional
    public void deleteResearch(long userId, UUID id) {
        if (!tools.deleteResearch(userId, id)) throw notFound();
    }

    private static ResearchItem merge(ResearchItem c, ResearchRequest r) {
        String url = r.url() == null ? c.url() : blankToNull(r.url());
        if (url != null && !url.matches("^https?://\\S+$")) throw new StudySpaceException(400, "INVALID_URL");
        Integer year = r.year() == null ? c.year() : r.year();
        if (year != null && (year < 1400 || year > 2200)) throw new StudySpaceException(400, "INVALID_YEAR");
        JsonNode annotations = r.annotations() == null ? c.annotations() : r.annotations();
        if (!annotations.isArray() || annotations.size() > 2000
                || annotations.toString().getBytes(StandardCharsets.UTF_8).length > 512 * 1024) {
            throw new StudySpaceException(400, "INVALID_ANNOTATIONS");
        }
        String title = r.title() == null ? c.title() : blankToNull(r.title());
        return new ResearchItem(c.id(), title == null ? null : title.strip(), r.authors() == null ? c.authors() : blankToNull(r.authors()),
                year, r.venue() == null ? c.venue() : blankToNull(r.venue()), r.doi() == null ? c.doi() : blankToNull(r.doi()), url,
                r.project() == null ? c.project() : blankToNull(r.project()), r.tags() == null ? c.tags() : blankToNull(r.tags()),
                r.favorite() == null ? c.favorite() : r.favorite(), r.fileName() == null ? c.fileName() : blankToNull(r.fileName()),
                r.fileSize() == null ? c.fileSize() : r.fileSize(),
                r.lastPage() == null ? c.lastPage() : Math.max(1, r.lastPage()), annotations,
                r.notes() == null ? c.notes() : r.notes(), c.createdAt(), c.updatedAt());
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────
    private static String required(String raw, int max) {
        String v = raw == null ? "" : raw.strip();
        if (v.isEmpty() || v.length() > max) throw new StudySpaceException(400, "INVALID_TITLE");
        return v;
    }

    private static String oneOf(String raw, Set<String> allowed) {
        if (raw == null || !allowed.contains(raw)) throw new StudySpaceException(400, "INVALID_REQUEST");
        return raw;
    }

    private static String trimTo(String raw, int max) {
        if (raw == null) return "";
        String v = raw.strip();
        return v.length() > max ? v.substring(0, max) : v;
    }

    private static String blankToNull(String raw) {
        return raw == null || raw.isBlank() ? null : raw.strip();
    }

    private static StudySpaceException notFound() {
        return new StudySpaceException(404, "NOT_FOUND");
    }
}
