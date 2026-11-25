package com.englishcoach.proficiency.api;

import com.englishcoach.proficiency.ProficiencyEvidenceRepository;
import com.englishcoach.proficiency.ProficiencyProperties;
import com.englishcoach.proficiency.ProficiencyStateRepository;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Read model for {@code GET /api/v1/proficiency/me} and the visibility toggle. */
@Service
@RequiredArgsConstructor
public class ProficiencyQueryService {

    private final ProficiencyProperties props;
    private final ProficiencyStateRepository stateRepository;
    private final ProficiencyEvidenceRepository evidenceRepository;

    @Transactional(readOnly = true)
    public ProficiencyDtos.ProficiencyMeResponse me(long userId) {
        Map<ProficiencySkill, ProficiencyStateRepository.StoredSkill> stored = stateRepository.findSkills(userId);
        Optional<ProficiencyStateRepository.StoredUser> user = stateRepository.findUser(userId);

        List<ProficiencyDtos.SkillDto> skills = new ArrayList<>();
        boolean missingT1 = false;
        for (ProficiencySkill skill : ProficiencySkill.values()) {
            if (!props.isActive(skill)) {
                skills.add(new ProficiencyDtos.SkillDto(skill.name(), null, null, 0.0, SkillStatus.UNSUPPORTED.name(), null));
                continue;
            }
            if (!evidenceRepository.hasTier(userId, EvidenceTier.T1, skill)) {
                missingT1 = true;
            }
            ProficiencyStateRepository.StoredSkill st = stored.get(skill);
            if (st == null) {
                skills.add(new ProficiencyDtos.SkillDto(skill.name(), null, null, 0.0, SkillStatus.UNDETERMINED.name(), null));
            } else {
                skills.add(new ProficiencyDtos.SkillDto(skill.name(), st.rating(),
                        st.rating() == null ? null : ProficiencyCefr.fromRating(st.rating()).name(),
                        st.confidence(), st.status().name(), st.lastEvidenceAt()));
            }
        }

        OverallStatus status = user.map(ProficiencyStateRepository.StoredUser::overallStatus).orElse(OverallStatus.UNDETERMINED);
        double confidence = user.map(ProficiencyStateRepository.StoredUser::overallConfidence).orElse(0.0);
        ProficiencyDtos.OverallDto overall = new ProficiencyDtos.OverallDto(
                user.map(ProficiencyStateRepository.StoredUser::overallRating).orElse(null),
                user.map(ProficiencyStateRepository.StoredUser::currentCefr).map(Enum::name).orElse(null),
                user.map(ProficiencyStateRepository.StoredUser::peakRating).orElse(null),
                user.map(ProficiencyStateRepository.StoredUser::peakCefr).map(Enum::name).orElse(null),
                confidence, status.name(), confidenceLabel(status, confidence));

        Map<String, String> formIds = new LinkedHashMap<>();
        props.getPlacement().getFormIds().forEach((k, v) -> formIds.put(k.name(), v));
        String cta = missingT1 ? props.getPlacement().getCtaUrl() : null;
        boolean show = user.map(ProficiencyStateRepository.StoredUser::showOnProficiencyBoard).orElse(true);
        return new ProficiencyDtos.ProficiencyMeResponse(overall, skills, cta, formIds, show);
    }

    @Transactional
    public ProficiencyDtos.VisibilityResponse setVisibility(long userId, boolean show) {
        stateRepository.setVisibility(userId, show, Instant.now());
        return new ProficiencyDtos.VisibilityResponse(show);
    }

    /**
     * ≥ 0.80 "Độ tin cậy cao", 0.60–0.79 "Đã xác thực" (VERIFIED), PROVISIONAL "Đang xác thực",
     * STALE "Cần xác thực lại", UNDETERMINED "Chưa xác định".
     */
    public static String confidenceLabel(OverallStatus status, double confidence) {
        return switch (status) {
            case UNDETERMINED -> "Chưa xác định";
            case STALE -> "Cần xác thực lại";
            case PROVISIONAL -> "Đang xác thực";
            case VERIFIED -> confidence >= 0.80 ? "Độ tin cậy cao" : "Đã xác thực";
        };
    }
}
