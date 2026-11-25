package com.englishcoach.studyspace;

import com.englishcoach.studyspace.StudySpaceDtos.FocusSession;
import com.englishcoach.studyspace.StudySpaceDtos.Note;
import com.englishcoach.studyspace.StudySpaceDtos.ResearchItem;
import com.englishcoach.studyspace.StudySpaceDtos.Task;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Tasks, notes, focus sessions and research metadata. Every statement is scoped by {@code user_id}. */
@Repository
public class StudyToolsRepository {

    private final JdbcTemplate jdbc;
    private final StudySpaceRepository spaces; // JSON helpers only

    public StudyToolsRepository(JdbcTemplate jdbc, StudySpaceRepository spaces) {
        this.jdbc = jdbc;
        this.spaces = spaces;
    }

    public int count(String table, long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public." + table + " WHERE user_id = ?", Integer.class, userId);
        return n == null ? 0 : n;
    }

    // ── Tasks ───────────────────────────────────────────────────────────────────────────────────────────────
    private static final String TASK = """
            SELECT t.id, t.title, t.notes, t.status, t.priority, t.due_on, t.project, t.recurrence, t.done_count, t.last_done_on,
                   t.position, t.done_at, t.created_at, t.updated_at,
                   coalesce((SELECT sum(f.focused_seconds) FROM public.study_focus_sessions f WHERE f.task_id = t.id AND f.user_id = t.user_id), 0) AS focused
            FROM public.study_tasks t""";

    public List<Task> tasks(long userId) {
        return jdbc.query(TASK + " WHERE t.user_id = ? ORDER BY t.status = 'DONE', t.position, t.created_at", this::task, userId);
    }

    public Optional<Task> task(long userId, UUID id) {
        return jdbc.query(TASK + " WHERE t.id = ? AND t.user_id = ?", this::task, id, userId).stream().findFirst();
    }

    public void insertTask(long userId, UUID id, String title, String notes, String status, int priority, LocalDate due,
                           String project, String recurrence, int position) {
        jdbc.update("""
                INSERT INTO public.study_tasks (id, user_id, title, notes, status, priority, due_on, project, recurrence, position, done_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'DONE' THEN now() END)""",
                id, userId, title, notes, status, priority, due == null ? null : Date.valueOf(due), project, recurrence,
                position, status);
    }

    public void updateTask(long userId, Task t) {
        jdbc.update("""
                UPDATE public.study_tasks SET title = ?, notes = ?, status = ?, priority = ?, due_on = ?, project = ?,
                    recurrence = ?, done_count = ?, last_done_on = ?, position = ?, done_at = ?, updated_at = now()
                WHERE id = ? AND user_id = ?""",
                t.title(), t.notes(), t.status(), t.priority(), t.dueOn() == null ? null : Date.valueOf(t.dueOn()), t.project(),
                t.recurrence(), t.doneCount(), t.lastDoneOn() == null ? null : Date.valueOf(t.lastDoneOn()), t.position(),
                t.doneAt() == null ? null : Timestamp.from(t.doneAt()), t.id(), userId);
    }

    public boolean deleteTask(long userId, UUID id) {
        return jdbc.update("DELETE FROM public.study_tasks WHERE id = ? AND user_id = ?", id, userId) == 1;
    }

    public int nextTaskPosition(long userId) {
        Integer n = jdbc.queryForObject("SELECT coalesce(max(position) + 1, 0) FROM public.study_tasks WHERE user_id = ?", Integer.class, userId);
        return n == null ? 0 : n;
    }

    private Task task(ResultSet rs, int n) throws SQLException {
        Date due = rs.getDate("due_on");
        Date last = rs.getDate("last_done_on");
        Timestamp done = rs.getTimestamp("done_at");
        return new Task(rs.getObject("id", UUID.class), rs.getString("title"), rs.getString("notes"), rs.getString("status"),
                rs.getInt("priority"), due == null ? null : due.toLocalDate(), rs.getString("project"), rs.getString("recurrence"),
                rs.getInt("done_count"), last == null ? null : last.toLocalDate(), rs.getInt("position"),
                done == null ? null : done.toInstant(), rs.getTimestamp("created_at").toInstant(),
                rs.getTimestamp("updated_at").toInstant(), rs.getInt("focused"));
    }

    // ── Notes ───────────────────────────────────────────────────────────────────────────────────────────────
    private static final String NOTE = "SELECT id, kind, title, body, color, pinned, created_at, updated_at FROM public.study_notes";

    public List<Note> notes(long userId) {
        return jdbc.query(NOTE + " WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC", this::note, userId);
    }

    public Optional<Note> note(long userId, UUID id) {
        return jdbc.query(NOTE + " WHERE id = ? AND user_id = ?", this::note, id, userId).stream().findFirst();
    }

    public void insertNote(long userId, UUID id, String kind, String title, String body, String color, boolean pinned) {
        jdbc.update("INSERT INTO public.study_notes (id, user_id, kind, title, body, color, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, userId, kind, title, body, color, pinned);
    }

    public void updateNote(long userId, Note n) {
        jdbc.update("UPDATE public.study_notes SET title = ?, body = ?, color = ?, pinned = ?, updated_at = now() WHERE id = ? AND user_id = ?",
                n.title(), n.body(), n.color(), n.pinned(), n.id(), userId);
    }

    public boolean deleteNote(long userId, UUID id) {
        return jdbc.update("DELETE FROM public.study_notes WHERE id = ? AND user_id = ?", id, userId) == 1;
    }

    private Note note(ResultSet rs, int n) throws SQLException {
        return new Note(rs.getObject("id", UUID.class), rs.getString("kind"), rs.getString("title"), rs.getString("body"),
                rs.getString("color"), rs.getBoolean("pinned"), rs.getTimestamp("created_at").toInstant(),
                rs.getTimestamp("updated_at").toInstant());
    }

    // ── Focus ───────────────────────────────────────────────────────────────────────────────────────────────
    private static final String FOCUS = """
            SELECT id, user_id, mode, status, planned_seconds, focused_seconds, task_id, label, subject, started_at, ended_at
            FROM public.study_focus_sessions""";

    /** The row with this id whoever owns it: a foreign id must be refused, never overwritten. */
    public Optional<long[]> focusOwner(UUID id) {
        return jdbc.query("SELECT user_id FROM public.study_focus_sessions WHERE id = ?", (rs, n) -> new long[]{rs.getLong(1)}, id)
                .stream().findFirst();
    }

    public Optional<FocusSession> focus(long userId, UUID id) {
        return jdbc.query(FOCUS + " WHERE id = ? AND user_id = ?", this::focus, id, userId).stream().findFirst();
    }

    public Instant now() {
        return jdbc.queryForObject("SELECT now()", Timestamp.class).toInstant();
    }

    public void insertFocus(long userId, UUID id, String mode, String status, int planned, int focused, UUID taskId,
                            String label, String subject, Instant startedAt, Instant endedAt) {
        jdbc.update("""
                INSERT INTO public.study_focus_sessions (id, user_id, mode, status, planned_seconds, focused_seconds, task_id,
                    label, subject, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING""",
                id, userId, mode, status, planned, focused, taskId, label, subject, Timestamp.from(startedAt),
                endedAt == null ? null : Timestamp.from(endedAt));
    }

    public void updateFocus(long userId, UUID id, String status, int focused, UUID taskId, String label, String subject, Instant endedAt) {
        jdbc.update("""
                UPDATE public.study_focus_sessions SET status = ?, focused_seconds = ?, task_id = ?, label = ?, subject = ?,
                    ended_at = ?, updated_at = now() WHERE id = ? AND user_id = ? AND status = 'RUNNING'""",
                status, focused, taskId, label, subject, endedAt == null ? null : Timestamp.from(endedAt), id, userId);
    }

    /** Sessions started at or after {@code from}, newest first (bounded). */
    public List<FocusSession> focusSince(long userId, Instant from, int limit) {
        return jdbc.query(FOCUS + " WHERE user_id = ? AND started_at >= ? ORDER BY started_at DESC LIMIT ?", this::focus,
                userId, Timestamp.from(from), limit);
    }

    /** Distinct local days (Asia/Ho_Chi_Minh) with focused time, newest first, for the focus streak. */
    public List<LocalDate> focusDays(long userId, int limit) {
        return jdbc.query("""
                SELECT DISTINCT (started_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS d FROM public.study_focus_sessions
                WHERE user_id = ? AND focused_seconds >= 60 ORDER BY d DESC LIMIT ?""",
                (rs, n) -> rs.getDate("d").toLocalDate(), userId, limit);
    }

    public boolean ownsTask(long userId, UUID taskId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.study_tasks WHERE id = ? AND user_id = ?", Integer.class, taskId, userId);
        return n != null && n > 0;
    }

    private FocusSession focus(ResultSet rs, int n) throws SQLException {
        Timestamp end = rs.getTimestamp("ended_at");
        return new FocusSession(rs.getObject("id", UUID.class), rs.getString("mode"), rs.getString("status"),
                rs.getInt("planned_seconds"), rs.getInt("focused_seconds"), rs.getObject("task_id", UUID.class),
                rs.getString("label"), rs.getString("subject"), rs.getTimestamp("started_at").toInstant(),
                end == null ? null : end.toInstant());
    }

    // ── Research ────────────────────────────────────────────────────────────────────────────────────────────
    private static final String RESEARCH = """
            SELECT id, title, authors, year, venue, doi, url, project, tags, favorite, file_name, file_size, last_page,
                   annotations, notes, created_at, updated_at FROM public.study_research_items""";

    public List<ResearchItem> research(long userId) {
        return jdbc.query(RESEARCH + " WHERE user_id = ? ORDER BY favorite DESC, updated_at DESC", this::researchRow, userId);
    }

    public Optional<ResearchItem> research(long userId, UUID id) {
        return jdbc.query(RESEARCH + " WHERE id = ? AND user_id = ?", this::researchRow, id, userId).stream().findFirst();
    }

    public void upsertResearch(long userId, ResearchItem r, boolean insert) {
        Object[] values = {r.title(), r.authors(), r.year(), r.venue(), r.doi(), r.url(), r.project(), r.tags(), r.favorite(),
                r.fileName(), r.fileSize(), r.lastPage(), spaces.text(r.annotations()), r.notes()};
        if (insert) {
            Object[] args = new Object[values.length + 2];
            args[0] = r.id();
            args[1] = userId;
            System.arraycopy(values, 0, args, 2, values.length);
            jdbc.update("""
                    INSERT INTO public.study_research_items (id, user_id, title, authors, year, venue, doi, url, project, tags,
                        favorite, file_name, file_size, last_page, annotations, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)""", args);
        } else {
            Object[] args = new Object[values.length + 2];
            System.arraycopy(values, 0, args, 0, values.length);
            args[values.length] = r.id();
            args[values.length + 1] = userId;
            jdbc.update("""
                    UPDATE public.study_research_items SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, url = ?, project = ?,
                        tags = ?, favorite = ?, file_name = ?, file_size = ?, last_page = ?, annotations = ?::jsonb, notes = ?,
                        updated_at = now() WHERE id = ? AND user_id = ?""", args);
        }
    }

    public boolean deleteResearch(long userId, UUID id) {
        return jdbc.update("DELETE FROM public.study_research_items WHERE id = ? AND user_id = ?", id, userId) == 1;
    }

    private ResearchItem researchRow(ResultSet rs, int n) throws SQLException {
        int year = rs.getInt("year");
        Integer y = rs.wasNull() ? null : year;
        long size = rs.getLong("file_size");
        Long s = rs.wasNull() ? null : size;
        return new ResearchItem(rs.getObject("id", UUID.class), rs.getString("title"), rs.getString("authors"), y,
                rs.getString("venue"), rs.getString("doi"), rs.getString("url"), rs.getString("project"), rs.getString("tags"),
                rs.getBoolean("favorite"), rs.getString("file_name"), s, rs.getInt("last_page"),
                spaces.node(rs.getString("annotations")), rs.getString("notes"), rs.getTimestamp("created_at").toInstant(),
                rs.getTimestamp("updated_at").toInstant());
    }
}
