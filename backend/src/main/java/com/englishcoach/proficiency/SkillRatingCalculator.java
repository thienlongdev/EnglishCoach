package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pure skill-rating function (Proficiency Spec §5 + §6). NO database access.
 * The ONLY producer of {@code skill_proficiency.rating}: observedRating is never copied into it.
 *
 * <p>§5 steps, in this exact order: (1) 365-day window, b = tierWeight · (2) repeats of the same
 * (source_module, material_key) keep b only for the earliest · (3) T3 mass caps per fixed 30-day
 * bucket on b (per module, then per skill; T1 never capped) · (4) decay w = b × 0.5^(age/90) ·
 * (5) T1 anchor zeroes T3 LOWER_BOUND evidence ≤ r1 · (6) rating = Σw·obs / Σw, sd weighted.
 * Caps use undecayed b and decay scales every w by the same factor over time, so with no new
 * evidence the rating is time-invariant; only W and confidence fall.
 */
@Component
@RequiredArgsConstructor
public class SkillRatingCalculator {

    private final ProficiencyProperties props;

    /** One evidence row as seen by the calculator. */
    public record Input(long id, EvidenceTier tier, EvidenceKind kind, String sourceModule, String materialKey,
                        int observedRating, double tierWeight, Instant occurredAt) {}

    /** Per-evidence base weight b (after repeats + caps) and effective weight w (after decay + anchor). */
    public record Weighted(Input input, double base, double weight) {}

    public record Result(ProficiencySkill skill, Integer rating, double weightSum, double sd, double confidence,
                         SkillStatus status, int evidenceCount, Instant lastEvidenceAt, boolean everVerified,
                         List<Weighted> weighted) {}

    /** Full computation on new evidence (rating recomputed). */
    public Result calculate(ProficiencySkill skill, List<Input> allEvidence, Instant now, boolean previouslyVerified) {
        if (!props.isActive(skill)) {
            return unsupported(skill, previouslyVerified);
        }
        Pipeline p = run(allEvidence, now);
        Integer rating = null;
        double sd = 0.0;
        if (p.weightSum > 0) {
            double mean = p.weightedSum / p.weightSum;
            rating = round(mean);
            double var = 0.0;
            for (Weighted w : p.window) {
                double d = w.input().observedRating() - mean;
                var += w.weight() * d * d;
            }
            sd = round2(Math.sqrt(var / p.weightSum));
        }
        double confidence = confidence(p.weightSum, sd);
        SkillStatus status = status(skill, p, now, previouslyVerified, confidence);
        return new Result(skill, rating, p.weightSum, sd, confidence, status, allEvidence.size(),
                p.lastEvidenceAt, previouslyVerified || status == SkillStatus.VERIFIED, p.window);
    }

    /**
     * Nightly refresh: rating and sd stay as stored (no rating drift — Hardening #5); only W,
     * confidence and status are re-evaluated.
     */
    public Result refresh(ProficiencySkill skill, List<Input> allEvidence, Instant now, boolean previouslyVerified,
                          Integer storedRating, double storedSd) {
        if (!props.isActive(skill)) {
            return unsupported(skill, previouslyVerified);
        }
        Pipeline p = run(allEvidence, now);
        double confidence = confidence(p.weightSum, storedSd);
        SkillStatus status = status(skill, p, now, previouslyVerified, confidence);
        return new Result(skill, storedRating, p.weightSum, storedSd, confidence, status, allEvidence.size(),
                p.lastEvidenceAt, previouslyVerified || status == SkillStatus.VERIFIED, p.window);
    }

    /** confidence = (1 − e^(−W/1.5)) × max(0.5, 1 − sd/300), rounded to 2 decimals. */
    public double confidence(double weightSum, double sd) {
        ProficiencyProperties.Status s = props.getStatus();
        double c = (1 - Math.exp(-weightSum / s.getConfidenceWeightScale()))
                * Math.max(s.getSdFloor(), 1 - sd / s.getSdScale());
        return round2(Math.max(0.0, c));
    }

    // ---- internals ------------------------------------------------------------------------------

    private record Pipeline(List<Weighted> window, double weightSum, double weightedSum,
                            List<Weighted> allBases, Instant lastEvidenceAt) {}

    private Pipeline run(List<Input> allEvidence, Instant now) {
        ProficiencyProperties.Rating r = props.getRating();
        Instant windowStart = now.minus(Duration.ofDays(r.getWindowDays()));

        // (1) window; b = tierWeight
        List<Input> window = allEvidence.stream()
                .filter(e -> !e.occurredAt().isBefore(windowStart) && !e.occurredAt().isAfter(now))
                .toList();
        // (2) repeats + (3) caps on undecayed b
        List<Weighted> bases = basesAfterRepeatsAndCaps(window);

        // (4) decay
        List<Weighted> decayed = new ArrayList<>(bases.size());
        for (Weighted b : bases) {
            double ageDays = Math.max(0.0, Duration.between(b.input().occurredAt(), now).toMillis() / 86_400_000.0);
            decayed.add(new Weighted(b.input(), b.base(), b.base() * Math.pow(0.5, ageDays / r.getHalfLifeDays())));
        }

        // (5) T1 anchor
        double t1w = 0.0;
        double t1ws = 0.0;
        for (Weighted w : decayed) {
            if (w.input().tier() == EvidenceTier.T1 && w.weight() > 0) {
                t1w += w.weight();
                t1ws += w.weight() * w.input().observedRating();
            }
        }
        List<Weighted> anchored = new ArrayList<>(decayed.size());
        if (t1w > 0) {
            double r1 = t1ws / t1w;
            for (Weighted w : decayed) {
                boolean dominated = w.input().tier() == EvidenceTier.T3
                        && w.input().kind() == EvidenceKind.LOWER_BOUND
                        && w.input().observedRating() <= r1;
                anchored.add(dominated ? new Weighted(w.input(), w.base(), 0.0) : w);
            }
        } else {
            anchored.addAll(decayed);
        }

        // (6) sums
        double sumW = 0.0;
        double sumWO = 0.0;
        for (Weighted w : anchored) {
            sumW += w.weight();
            sumWO += w.weight() * w.input().observedRating();
        }

        // Status helpers use ALL evidence (no window, undecayed b) so time alone never makes a
        // skill UNDETERMINED and STALE can be detected even when everything is older than 365 days.
        List<Weighted> allBases = basesAfterRepeatsAndCaps(allEvidence);
        Instant last = allEvidence.stream().map(Input::occurredAt).max(Comparator.naturalOrder()).orElse(null);
        return new Pipeline(anchored, sumW, sumWO, allBases, last);
    }

    /** Steps (2) and (3): repeats keep b only for the earliest per material; then T3 caps per bucket. */
    List<Weighted> basesAfterRepeatsAndCaps(List<Input> evidence) {
        ProficiencyProperties.Rating r = props.getRating();
        List<Input> sorted = new ArrayList<>(evidence);
        sorted.sort(Comparator.comparing(Input::occurredAt).thenComparingLong(Input::id));

        Set<String> seen = new HashSet<>();
        double[] base = new double[sorted.size()];
        for (int i = 0; i < sorted.size(); i++) {
            Input e = sorted.get(i);
            String key = e.sourceModule() + "|" + e.materialKey();
            base[i] = seen.add(key) ? e.tierWeight() : e.tierWeight() * r.getRepeatWeight();
        }

        // (3a) per module per bucket
        Map<String, List<Integer>> byModuleBucket = new HashMap<>();
        Map<Long, List<Integer>> bySkillBucket = new HashMap<>();
        for (int i = 0; i < sorted.size(); i++) {
            Input e = sorted.get(i);
            if (e.tier() != EvidenceTier.T3) continue;
            long bucket = bucketOf(e.occurredAt());
            byModuleBucket.computeIfAbsent(bucket + "|" + e.sourceModule(), k -> new ArrayList<>()).add(i);
            bySkillBucket.computeIfAbsent(bucket, k -> new ArrayList<>()).add(i);
        }
        for (List<Integer> idx : byModuleBucket.values()) {
            scaleDown(base, idx, r.getT3PerModuleCap());
        }
        // (3b) per skill per bucket (evidence passed in belongs to one skill)
        for (List<Integer> idx : bySkillBucket.values()) {
            scaleDown(base, idx, r.getT3PerSkillCap());
        }

        List<Weighted> out = new ArrayList<>(sorted.size());
        for (int i = 0; i < sorted.size(); i++) {
            out.add(new Weighted(sorted.get(i), base[i], base[i]));
        }
        return out;
    }

    private static void scaleDown(double[] base, List<Integer> idx, double cap) {
        double sum = 0.0;
        for (int i : idx) sum += base[i];
        if (sum > cap && sum > 0) {
            double f = cap / sum;
            for (int i : idx) base[i] *= f;
        }
    }

    long bucketOf(Instant at) {
        ProficiencyProperties.Rating r = props.getRating();
        LocalDate d = at.atZone(ZoneId.of(props.getTimeZone())).toLocalDate();
        long days = ChronoUnit.DAYS.between(r.getBucketEpoch(), d);
        return Math.floorDiv(days, r.getBucketDays());
    }

    /** §6 status precedence: UNSUPPORTED → STALE → UNDETERMINED → VERIFIED → PROVISIONAL. */
    private SkillStatus status(ProficiencySkill skill, Pipeline p, Instant now, boolean previouslyVerified,
                               double confidence) {
        ProficiencyProperties.Status s = props.getStatus();
        if (!props.isActive(skill)) {
            return SkillStatus.UNSUPPORTED;
        }
        Instant newestValid = p.allBases.stream().filter(w -> w.base() > 0)
                .map(w -> w.input().occurredAt()).max(Comparator.naturalOrder()).orElse(null);
        if (previouslyVerified && newestValid != null
                && newestValid.isBefore(now.minus(Duration.ofDays(s.getStaleDays())))) {
            return SkillStatus.STALE;
        }
        long positive = p.allBases.stream().filter(w -> w.base() > 0).count();
        double baseSum = p.allBases.stream().mapToDouble(Weighted::base).sum();
        if (positive < s.getUndeterminedMinEvidence() || baseSum < s.getUndeterminedMinBaseSum()) {
            return SkillStatus.UNDETERMINED;
        }
        boolean hasVerifyingTier = p.window.stream().anyMatch(w -> w.base() > 0
                && props.getVerificationTiers().contains(w.input().tier()));
        if (hasVerifyingTier && confidence >= s.getVerifiedConfidence()) {
            return SkillStatus.VERIFIED;
        }
        return SkillStatus.PROVISIONAL;
    }

    private Result unsupported(ProficiencySkill skill, boolean previouslyVerified) {
        return new Result(skill, null, 0.0, 0.0, 0.0, SkillStatus.UNSUPPORTED, 0, null, previouslyVerified, List.of());
    }

    static int round(double v) {
        return BigDecimal.valueOf(v).setScale(0, RoundingMode.HALF_UP).intValue();
    }

    static double round2(double v) {
        return BigDecimal.valueOf(v).setScale(2, RoundingMode.HALF_UP).doubleValue();
    }
}
