package com.englishcoach.community.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.community.entity.AuthorType;
import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.PostStatus;
import com.englishcoach.community.entity.PostType;
import com.englishcoach.community.repository.CommunityPostRepository;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Optional;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityDailyVocabularyService {

    public static final String SERIES_TYPE = "DAILY_VOCAB";
    public static final ZoneId VN_ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    private final CommunityPostRepository postRepository;
    private final DictionaryRepository dictionaryRepository;
    private final UserRepository userRepository;

    /**
     * Deterministically ensures a single official Daily Vocabulary post exists for the given local Vietnam date.
     * Idempotent, restart-safe, duplicate-proof.
     */
    @Transactional
    public CommunityPost ensureDailyVocabularyPost(LocalDate date) {
        if (date == null) {
            date = LocalDate.now(VN_ZONE);
        }

        // 1. Check if already generated for this calendar date
        Optional<CommunityPost> existingOpt = postRepository.findBySeriesTypeAndScheduledDate(SERIES_TYPE, date);
        if (existingOpt.isPresent()) {
            log.info("Daily vocabulary post for {} already exists (post id: {}), skipping generation.", date, existingOpt.get().getId());
            return existingOpt.get();
        }

        // 2. Deterministically select a word from authoritative dictionary_entries
        long totalEligible = dictionaryRepository.countByGeneralTranslationViIsNotNull();
        if (totalEligible == 0) {
            log.warn("No eligible dictionary entries with Vietnamese translation found for daily vocab post.");
            return null;
        }

        // Mathematical deterministic selection based on epoch day
        long epochDay = date.toEpochDay();
        int offset = (int) (Math.abs(epochDay * 7919L + 1013L) % totalEligible);

        Page<DictionaryEntry> page = dictionaryRepository.findByGeneralTranslationViIsNotNull(PageRequest.of(offset, 1));
        if (!page.hasContent()) {
            log.warn("Failed to fetch dictionary entry at offset {}", offset);
            return null;
        }

        DictionaryEntry entry = page.getContent().get(0);
        String word = entry.getWord();
        String ipa = entry.getIpa() != null && !entry.getIpa().isBlank() ? "/" + entry.getIpa().replace("/", "") + "/" : "";
        String meaning = entry.getGeneralTranslationVi() != null && !entry.getGeneralTranslationVi().isBlank()
                ? entry.getGeneralTranslationVi()
                : (entry.getMeanings() != null && !entry.getMeanings().isEmpty() ? entry.getMeanings().get(0) : "");

        String example = "";
        if (entry.getExamples() != null && !entry.getExamples().isEmpty()) {
            example = entry.getExamples().get(0);
        }

        // 3. Format into a social-first EnglishCoach learning post
        StringBuilder sb = new StringBuilder();
        sb.append("📖 Từ vựng hôm nay: ").append(word).append("\n\n");
        if (!ipa.isBlank()) {
            sb.append(ipa).append("\n\n");
        }
        if (!meaning.isBlank()) {
            sb.append(meaning).append("\n\n");
        }
        if (!example.isBlank()) {
            sb.append("Example:\n").append(example).append("\n\n");
        }
        sb.append("👉 Bấm \"Lưu Flashcard\" để ôn tập từ này mỗi ngày!\n\n");
        sb.append("#TuVungHangNgay #EnglishCoach");

        // 4. Resolve official publisher actor for audit
        User publisherAdmin = userRepository.findFirstByRole(Role.ROLE_ADMIN)
                .or(() -> userRepository.findAll().stream().findFirst())
                .orElse(null);

        if (publisherAdmin == null) {
            log.warn("No user found in repository to attribute official post.");
            return null;
        }

        CommunityPost post = CommunityPost.builder()
                .author(publisherAdmin)
                .authorType(AuthorType.OFFICIAL)
                .createdByAdminId(publisherAdmin.getId())
                .updatedByAdminId(publisherAdmin.getId())
                .status(PostStatus.PUBLISHED)
                .postType(PostType.LEARNING)
                .content(sb.toString().trim())
                .isPinned(false)
                .isFeatured(false)
                .seriesType(SERIES_TYPE)
                .scheduledDate(date)
                .publishedAt(Instant.now())
                .sharedEntityId(word) // Word key for flashcard action
                .likeCount(0)
                .commentCount(0)
                .saveCount(0)
                .build();

        try {
            post = postRepository.save(post);
            log.info("Successfully generated official Daily Vocabulary post for {} with word '{}' (post id: {})", date, word, post.getId());
            return post;
        } catch (Exception e) {
            // Race condition caught by unique index idx_community_posts_series_daily
            log.warn("Concurrent duplicate prevention caught for daily post {}: {}", date, e.getMessage());
            return postRepository.findBySeriesTypeAndScheduledDate(SERIES_TYPE, date).orElse(null);
        }
    }
}
