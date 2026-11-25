package com.englishcoach.studyspace;

import com.englishcoach.studyspace.StudySpaceDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Không gian học tập — a learner's spaces. The CURRENT layout (auto-saved while they work) and their PERSONAL DEFAULT
 * ("Lưu làm mặc định của tôi") are separate columns: clearing, restoring or auto-saving the current layout never writes
 * the default; only {@link #saveDefault} does, and it keeps the replaced default as a snapshot. A layout is opaque JSON
 * to the server: bounded in size and shape, never interpreted, never shared.
 */
@Service
public class StudySpaceService {

    static final int MAX_SPACES = 12;
    static final int MAX_SNAPSHOTS = 20;
    static final int MAX_NAMED_ROOMS = 30;
    static final int MAX_LAYOUT_BYTES = 256 * 1024;
    private static final Set<String> REASONS = Set.of("NONE", "CLEAR", "RESTORE", "TEMPLATE");

    private final StudySpaceRepository spaces;

    public StudySpaceService(StudySpaceRepository spaces) {
        this.spaces = spaces;
    }

    @Transactional(readOnly = true)
    public SpaceList list(long userId) {
        return new SpaceList(spaces.list(userId), spaces.active(userId).orElse(null), MAX_SPACES);
    }

    @Transactional(readOnly = true)
    public Space get(long userId, UUID id) {
        return spaces.find(userId, id).orElseThrow(StudySpaceService::notFound);
    }

    @Transactional
    public Space create(long userId, CreateSpaceRequest request) {
        spaces.lockOwner(userId);
        int count = spaces.count(userId);
        if (count >= MAX_SPACES) throw new StudySpaceException(409, "SPACE_LIMIT");
        JsonNode layout;
        JsonNode defaultLayout = null;
        if (request.copyFrom() != null) {
            Space source = spaces.find(userId, request.copyFrom()).orElseThrow(StudySpaceService::notFound);
            layout = source.layout();
            defaultLayout = source.defaultLayout();
        } else {
            layout = request.layout();
        }
        validate(layout);
        UUID id = UUID.randomUUID();
        spaces.insert(userId, id, name(request.name()), spaces.nextPosition(userId), layout, defaultLayout);
        if (count == 0 || Boolean.TRUE.equals(request.activate())) spaces.activate(userId, id);
        return spaces.find(userId, id).orElseThrow();
    }

    @Transactional
    public Space rename(long userId, UUID id, String name) {
        if (!spaces.rename(userId, id, name(name))) throw notFound();
        return get(userId, id);
    }

    @Transactional
    public Space activate(long userId, UUID id) {
        spaces.lockOwner(userId);
        spaces.find(userId, id).orElseThrow(StudySpaceService::notFound);
        spaces.activate(userId, id);
        return get(userId, id);
    }

    /**
     * Replaces the current layout. A CLEAR, RESTORE or TEMPLATE keeps the layout it replaces as a snapshot first, so
     * "Khôi phục phiên bản trước" can bring it back. With a revision, a newer save from another tab wins (409).
     */
    @Transactional
    public Space saveLayout(long userId, UUID id, SaveLayoutRequest request) {
        validate(request.layout());
        String reason = request.reason() == null ? "NONE" : request.reason();
        if (!REASONS.contains(reason)) throw new StudySpaceException(400, "INVALID_REQUEST");
        spaces.lockOwner(userId);
        Space current = spaces.find(userId, id).orElseThrow(StudySpaceService::notFound);
        if (!"NONE".equals(reason)) {
            spaces.insertSnapshot(userId, id, "BEFORE_" + reason, null, current.layout());
            spaces.pruneSnapshots(userId, id, MAX_SNAPSHOTS);
        }
        if (spaces.saveLayout(userId, id, request.layout(), request.revision()) < 0) {
            throw new StudySpaceException(409, "STALE_REVISION");
        }
        return get(userId, id);
    }

    /** "Lưu làm mặc định của tôi": the only writer of the personal default. The replaced default becomes a snapshot. */
    @Transactional
    public Space saveDefault(long userId, UUID id, JsonNode layout) {
        validate(layout);
        spaces.lockOwner(userId);
        Space current = spaces.find(userId, id).orElseThrow(StudySpaceService::notFound);
        if (current.defaultLayout() != null) {
            spaces.insertSnapshot(userId, id, "BEFORE_DEFAULT", null, current.defaultLayout());
            spaces.pruneSnapshots(userId, id, MAX_SNAPSHOTS);
        }
        spaces.saveDefault(userId, id, layout);
        return get(userId, id);
    }

    @Transactional
    public void delete(long userId, UUID id) {
        spaces.lockOwner(userId);
        Space doomed = spaces.find(userId, id).orElseThrow(StudySpaceService::notFound);
        spaces.delete(userId, id);
        if (doomed.active()) {
            List<SpaceSummary> rest = spaces.list(userId);
            if (!rest.isEmpty()) spaces.activate(userId, rest.get(0).id());
        }
    }

    @Transactional(readOnly = true)
    public List<Snapshot> snapshots(long userId, UUID spaceId) {
        spaces.find(userId, spaceId).orElseThrow(StudySpaceService::notFound);
        return spaces.snapshots(userId, spaceId);
    }

    @Transactional(readOnly = true)
    public SnapshotDetail snapshot(long userId, UUID spaceId, UUID id) {
        return spaces.snapshot(userId, spaceId, id).orElseThrow(StudySpaceService::notFound);
    }

    @Transactional
    public List<Snapshot> createSnapshot(long userId, UUID spaceId, CreateSnapshotRequest request) {
        validate(request.layout());
        spaces.lockOwner(userId);
        spaces.find(userId, spaceId).orElseThrow(StudySpaceService::notFound);
        String label = request.label() == null || request.label().isBlank() ? null : request.label().strip();
        if (label != null && label.startsWith(StudySpaceRepository.NAMED_ROOM.strip())) {
            label = StudySpaceRepository.NAMED_ROOM + label.substring(1).strip();
            if (spaces.countNamedRooms(userId, spaceId) >= MAX_NAMED_ROOMS) throw new StudySpaceException(409, "NAMED_ROOM_LIMIT");
        }
        spaces.insertSnapshot(userId, spaceId, "MANUAL", label, request.layout());
        spaces.pruneSnapshots(userId, spaceId, MAX_SNAPSHOTS);
        return spaces.snapshots(userId, spaceId);
    }

    @Transactional
    public void deleteSnapshot(long userId, UUID spaceId, UUID id) {
        spaces.lockOwner(userId);
        spaces.find(userId, spaceId).orElseThrow(StudySpaceService::notFound);
        if (spaces.deleteSnapshot(userId, spaceId, id) == 0) throw notFound();
    }

    /** A layout is a JSON object with a numeric schema version, bounded in bytes and in item counts. */
    void validate(JsonNode layout) {
        if (layout == null || !layout.isObject() || !layout.path("v").isInt()) throw new StudySpaceException(400, "INVALID_LAYOUT");
        if (spaces.text(layout).getBytes(StandardCharsets.UTF_8).length > MAX_LAYOUT_BYTES) throw new StudySpaceException(413, "LAYOUT_TOO_LARGE");
        JsonNode objects = layout.path("objects");
        JsonNode widgets = layout.path("widgets");
        if ((!objects.isMissingNode() && (!objects.isArray() || objects.size() > 400))
                || (!widgets.isMissingNode() && (!widgets.isArray() || widgets.size() > 60))) {
            throw new StudySpaceException(400, "INVALID_LAYOUT");
        }
    }

    private static String name(String raw) {
        String n = raw == null ? "" : raw.strip();
        if (n.isEmpty() || n.length() > 60) throw new StudySpaceException(400, "INVALID_NAME");
        return n;
    }

    private static StudySpaceException notFound() {
        return new StudySpaceException(404, "NOT_FOUND");
    }
}
