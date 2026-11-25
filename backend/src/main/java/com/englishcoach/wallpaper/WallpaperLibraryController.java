package com.englishcoach.wallpaper;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.wallpaper.WallpaperLibraryDtos.*;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

/**
 * Hình nền — "Video YouTube của tôi" for the signed-in learner ({@code anyRequest().authenticated()}; CSRF as every
 * cookie-authenticated write). Every call is scoped to the principal; there is no user-id parameter.
 */
@RestController
@Validated
@RequestMapping("/api/v1/wallpaper/youtube-videos")
public class WallpaperLibraryController {

    private final WallpaperLibraryService library;

    public WallpaperLibraryController(WallpaperLibraryService library) {
        this.library = library;
    }

    @GetMapping
    public ResponseEntity<EntryList> list(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(library.list(owner(user)));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Entry> get(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        return ok(library.get(owner(user), id));
    }

    @PostMapping
    public ResponseEntity<SaveResponse> save(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody SaveRequest request) {
        SaveResponse saved = library.save(owner(user), request.videoId());
        return ResponseEntity.status(saved.created() ? 201 : 200).cacheControl(CacheControl.noStore()).body(saved);
    }

    @PostMapping("/import")
    public ResponseEntity<ImportResponse> importDeviceList(@AuthenticationPrincipal UserDetailsImpl user,
                                                           @Valid @RequestBody ImportRequest request) {
        return ok(library.importDeviceList(owner(user), request.videoIds()));
    }

    @PutMapping("/{id}/background")
    public ResponseEntity<Entry> setBackground(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id,
                                               @Valid @RequestBody BackgroundRequest request) {
        return ok(library.setBackground(owner(user), id, request));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id) {
        library.delete(owner(user), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new WallpaperLibraryException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
