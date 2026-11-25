package com.englishcoach.reading.controller;

import com.englishcoach.reading.service.ReadingCorpusImporter;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.ResponseEntity;
import org.springframework.http.CacheControl;

@RestController
@RequestMapping("/api/v1/reading/admin/corpus")
@RequiredArgsConstructor
@PreAuthorize("hasRole('ADMIN')")
public class ReadingCorpusController {
    private final ReadingCorpusImporter importer;
    public record Request(boolean apply, boolean allowUpdates, String manifestSha256) {}
    @PostMapping
    public ResponseEntity<ReadingCorpusImporter.Result> run(@RequestBody Request request) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(importer.run(request.apply(), request.allowUpdates(),request.manifestSha256()));
    }
}
