package com.englishcoach.flashcard.pvp.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.MissedWordDetail;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping({"/api/flashcards/pvp", "/api/v1/flashcards/pvp"})
@RequiredArgsConstructor
@Slf4j
public class CardBlastPvPRestController {

    private final CardBlastPvPService pvpService;

    @GetMapping("/missed-words")
    public ResponseEntity<List<MissedWordDetail>> getMissedWords(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(value = "matchId", required = false) Long matchId) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        log.info("[PVP REST] getMissedWords for userId={}, matchId={}", userId, matchId);
        return ResponseEntity.ok(pvpService.getMissedWordDetails(userId, matchId));
    }
}
