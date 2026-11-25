package com.englishcoach.studyspace;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.studyspace.StudySpaceDtos.*;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/**
 * Không gian học tập for the signed-in learner ({@code anyRequest().authenticated()}; CSRF as every cookie-authenticated
 * write). Every call is scoped to the principal: there is no user-id parameter, a foreign id answers 404 like a missing one.
 * No AI, no media: layouts reference catalogue ids, documents stay in the learner's browser.
 */
@RestController
@Validated
@RequestMapping("/api/v1/study-space")
public class StudySpaceController {

    private final StudySpaceService spaces;
    private final StudyToolsService tools;

    public StudySpaceController(StudySpaceService spaces, StudyToolsService tools) {
        this.spaces = spaces;
        this.tools = tools;
    }

    // ── Spaces ──────────────────────────────────────────────────────────────────────────────────────────────
    @GetMapping("/spaces")
    public ResponseEntity<SpaceList> list(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(spaces.list(owner(user)));
    }

    @GetMapping("/spaces/{id}")
    public ResponseEntity<Space> get(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        return ok(spaces.get(owner(user), id));
    }

    @PostMapping("/spaces")
    public ResponseEntity<Space> create(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody CreateSpaceRequest request) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore()).body(spaces.create(owner(user), request));
    }

    @PutMapping("/spaces/{id}/name")
    public ResponseEntity<Space> rename(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody RenameRequest request) {
        return ok(spaces.rename(owner(user), id, request.name()));
    }

    @PostMapping("/spaces/{id}/activate")
    public ResponseEntity<Space> activate(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        return ok(spaces.activate(owner(user), id));
    }

    @PutMapping("/spaces/{id}/layout")
    public ResponseEntity<Space> saveLayout(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody SaveLayoutRequest request) {
        return ok(spaces.saveLayout(owner(user), id, request));
    }

    @PutMapping("/spaces/{id}/default")
    public ResponseEntity<Space> saveDefault(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody SaveDefaultRequest request) {
        return ok(spaces.saveDefault(owner(user), id, request.layout()));
    }

    @DeleteMapping("/spaces/{id}")
    public ResponseEntity<Void> delete(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        spaces.delete(owner(user), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @GetMapping("/spaces/{id}/snapshots")
    public ResponseEntity<List<Snapshot>> snapshots(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        return ok(spaces.snapshots(owner(user), id));
    }

    @PostMapping("/spaces/{id}/snapshots")
    public ResponseEntity<List<Snapshot>> createSnapshot(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id,
                                                         @Valid @RequestBody CreateSnapshotRequest request) {
        return ok(spaces.createSnapshot(owner(user), id, request));
    }

    @DeleteMapping("/spaces/{id}/snapshots/{snapshotId}")
    public ResponseEntity<Void> deleteSnapshot(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @PathVariable UUID snapshotId) {
        spaces.deleteSnapshot(owner(user), id, snapshotId);
        return ResponseEntity.noContent().cacheControl(org.springframework.http.CacheControl.noStore()).build();
    }

    @GetMapping("/spaces/{id}/snapshots/{snapshotId}")
    public ResponseEntity<SnapshotDetail> snapshot(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @PathVariable UUID snapshotId) {
        return ok(spaces.snapshot(owner(user), id, snapshotId));
    }

    // ── Tasks ───────────────────────────────────────────────────────────────────────────────────────────────
    @GetMapping("/tasks")
    public ResponseEntity<List<Task>> tasks(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(tools.tasks(owner(user)));
    }

    @PostMapping("/tasks")
    public ResponseEntity<Task> createTask(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody TaskRequest request) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore()).body(tools.createTask(owner(user), request));
    }

    @PutMapping("/tasks/{id}")
    public ResponseEntity<Task> updateTask(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody TaskRequest request) {
        return ok(tools.updateTask(owner(user), id, request));
    }

    @DeleteMapping("/tasks/{id}")
    public ResponseEntity<Void> deleteTask(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        tools.deleteTask(owner(user), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    // ── Notes ───────────────────────────────────────────────────────────────────────────────────────────────
    @GetMapping("/notes")
    public ResponseEntity<List<Note>> notes(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(tools.notes(owner(user)));
    }

    @PostMapping("/notes")
    public ResponseEntity<Note> createNote(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody NoteRequest request) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore()).body(tools.createNote(owner(user), request));
    }

    @PutMapping("/notes/{id}")
    public ResponseEntity<Note> updateNote(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody NoteRequest request) {
        return ok(tools.updateNote(owner(user), id, request));
    }

    @DeleteMapping("/notes/{id}")
    public ResponseEntity<Void> deleteNote(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        tools.deleteNote(owner(user), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    // ── Focus ───────────────────────────────────────────────────────────────────────────────────────────────
    @PutMapping("/focus/sessions/{id}")
    public ResponseEntity<FocusSession> reportFocus(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody FocusReport request) {
        return ok(tools.reportFocus(owner(user), id, request));
    }

    @GetMapping("/focus/stats")
    public ResponseEntity<FocusStats> focusStats(@AuthenticationPrincipal UserDetailsImpl user, @RequestParam(defaultValue = "7") int days) {
        return ok(tools.focusStats(owner(user), days));
    }

    // ── Research ────────────────────────────────────────────────────────────────────────────────────────────
    @GetMapping("/research")
    public ResponseEntity<List<ResearchItem>> research(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(tools.research(owner(user)));
    }

    @PostMapping("/research")
    public ResponseEntity<ResearchItem> createResearch(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody ResearchRequest request) {
        return ResponseEntity.status(201).cacheControl(CacheControl.noStore()).body(tools.createResearch(owner(user), request));
    }

    @PutMapping("/research/{id}")
    public ResponseEntity<ResearchItem> updateResearch(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @Valid @RequestBody ResearchRequest request) {
        return ok(tools.updateResearch(owner(user), id, request));
    }

    @DeleteMapping("/research/{id}")
    public ResponseEntity<Void> deleteResearch(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        tools.deleteResearch(owner(user), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new StudySpaceException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
