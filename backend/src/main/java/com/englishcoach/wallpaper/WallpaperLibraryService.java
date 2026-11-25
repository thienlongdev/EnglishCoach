package com.englishcoach.wallpaper;

import com.englishcoach.wallpaper.WallpaperLibraryDtos.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Hình nền — "Video YouTube của tôi": the learner's saved YouTube videos, kept with the account. The owner is always the
 * authenticated principal; an entry of another learner answers exactly like a missing one (404). No AI, no outgoing
 * request, no metadata lookup: only validated ids and the learner's own background source are stored.
 */
@Service
public class WallpaperLibraryService {

    private final WallpaperLibraryRepository repository;

    public WallpaperLibraryService(WallpaperLibraryRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public EntryList list(long userId) {
        return new EntryList(repository.list(userId, WallpaperLibraryRules.MAX_ENTRIES), WallpaperLibraryRules.MAX_ENTRIES);
    }

    @Transactional(readOnly = true)
    public Entry get(long userId, UUID id) {
        return repository.find(userId, id).orElseThrow(WallpaperLibraryService::notFound);
    }

    /** Saving a video twice returns the existing entry (never a duplicate); a full library refuses with 409. */
    @Transactional
    public SaveResponse save(long userId, String videoId) {
        if (!WallpaperLibraryRules.isVideoId(videoId)) throw new WallpaperLibraryException(400, "INVALID_VIDEO_ID");
        repository.lockOwner(userId);
        var existing = repository.findByVideo(userId, videoId);
        if (existing.isPresent()) return new SaveResponse(existing.get(), false);
        if (repository.count(userId) >= WallpaperLibraryRules.MAX_ENTRIES) throw new WallpaperLibraryException(409, "LIBRARY_FULL");
        return new SaveResponse(repository.insert(userId, videoId, Instant.now()), true);
    }

    /**
     * The former device-only list of THIS learner (the client reads only the principal's own device key). Every id is
     * validated (one bad id refuses the whole call: nothing partial); saved ones are kept as they are; the order of the
     * device list (newest first) is kept below the newest server entry; ids beyond the limit are reported, not stored.
     */
    @Transactional
    public ImportResponse importDeviceList(long userId, List<String> videoIds) {
        if (videoIds == null || videoIds.size() > WallpaperLibraryRules.MAX_IMPORT) throw new WallpaperLibraryException(400, "INVALID_REQUEST");
        Set<String> unique = new LinkedHashSet<>();
        for (String id : videoIds) {
            if (!WallpaperLibraryRules.isVideoId(id)) throw new WallpaperLibraryException(400, "INVALID_VIDEO_ID");
            unique.add(id);
        }
        repository.lockOwner(userId);
        int count = repository.count(userId);
        int imported = 0, already = 0, overLimit = 0;
        // Device saves are older than anything already in the account: they go below its oldest entry.
        Instant now = Instant.now();
        Instant oldest = repository.oldestCreatedAt(userId).orElse(now);
        Instant base = oldest.isBefore(now) ? oldest : now;
        int position = 0;
        for (String id : unique) {
            position++;
            if (repository.findByVideo(userId, id).isPresent()) {
                already++;
            } else if (count >= WallpaperLibraryRules.MAX_ENTRIES) {
                overLimit++;
            } else {
                // Newest first in the device list ⇒ each later id is a millisecond older.
                repository.insert(userId, id, base.minusMillis(position));
                count++;
                imported++;
            }
        }
        return new ImportResponse(repository.list(userId, WallpaperLibraryRules.MAX_ENTRIES), imported, already, overLimit,
                WallpaperLibraryRules.MAX_ENTRIES);
    }

    @Transactional
    public Entry setBackground(long userId, UUID id, BackgroundRequest request) {
        String kind = request == null ? null : request.kind();
        String url = null, fileName = null;
        if (kind == null) {
            // clear
        } else if ("LINK".equals(kind)) {
            url = WallpaperLibraryRules.normalizeVideoLink(request.url())
                    .orElseThrow(() -> new WallpaperLibraryException(400, "INVALID_VIDEO_LINK"));
        } else if ("FILE".equals(kind)) {
            fileName = WallpaperLibraryRules.cleanFileName(request.fileName())
                    .orElseThrow(() -> new WallpaperLibraryException(400, "INVALID_FILE_NAME"));
        } else {
            throw new WallpaperLibraryException(400, "INVALID_REQUEST");
        }
        if (!repository.setBackground(userId, id, kind, url, fileName)) throw notFound();
        return repository.find(userId, id).orElseThrow(WallpaperLibraryService::notFound);
    }

    @Transactional
    public void delete(long userId, UUID id) {
        if (!repository.delete(userId, id)) throw notFound();
    }

    private static WallpaperLibraryException notFound() {
        return new WallpaperLibraryException(404, "ENTRY_NOT_FOUND");
    }
}
