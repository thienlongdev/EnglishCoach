package com.englishcoach.listening.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.listening.service.ListeningDocumentService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.http.*;
import org.springframework.core.io.Resource;
import org.springframework.web.multipart.MultipartFile;
import java.util.*;

@RestController
@RequestMapping("/api/v1/listening")
@RequiredArgsConstructor
public class ListeningDocumentController {
    private final ListeningDocumentService documents;
    private final com.englishcoach.auth.service.LoginThrottleService throttle;
    @PostMapping("/documents/extract")
    public ResponseEntity<Map<String,String>> extract(@AuthenticationPrincipal UserDetailsImpl user,
            @RequestParam("file") MultipartFile file,@RequestParam("title") String title) {
        Long id=principal(user);
        limit(id,"LISTENING_DOCUMENT_EXTRACT",6);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(Map.of("text",documents.extract(file,title,id)));
    }
    @PostMapping("/documents")
    public ResponseEntity<ListeningDocumentService.Job> create(@AuthenticationPrincipal UserDetailsImpl user,
            @RequestBody ListeningDocumentService.Request request) {
        Long owner=principal(user); limit(owner,"LISTENING_DOCUMENT_CREATE",10);
        return ResponseEntity.accepted().cacheControl(CacheControl.noStore()).body(documents.create(owner,request));
    }
    @GetMapping("/documents/{jobId}")
    public ResponseEntity<ListeningDocumentService.Job> job(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable UUID jobId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(documents.get(principal(user),jobId));
    }
    @GetMapping("/materials/{id}/audio")
    public ResponseEntity<Resource> audio(@AuthenticationPrincipal UserDetailsImpl user,@PathVariable Long id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header(HttpHeaders.ACCEPT_RANGES,"bytes")
                .contentType(MediaType.parseMediaType("audio/wav")).body(documents.media(principal(user),id));
    }
    private static Long principal(UserDetailsImpl user) {
        if(user==null) throw new org.springframework.web.server.ResponseStatusException(HttpStatus.UNAUTHORIZED,"Vui lòng đăng nhập.");
        return user.getId();
    }
    private void limit(Long user,String kind,int max) {
        if(!throttle.countRequest(kind,"user:"+user,max,1))
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Vui lòng chờ trước khi thử lại.");
    }
}
