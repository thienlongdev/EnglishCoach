package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Pure §5/§6 behaviour of {@link SkillRatingCalculator}. */
class SkillRatingCalculatorTest {

    static final Instant NOW = Instant.parse("2026-10-01T03:00:00Z"); // bucket 9 = 2026-09-28 .. 2026-10-27

    private final ProficiencyProperties props = new ProficiencyProperties();
    private final SkillRatingCalculator calc = new SkillRatingCalculator(props);
    private long ids = 1;

    private SkillRatingCalculator.Input t1(int observed, Instant at) {
        long id = ids++;
        return new SkillRatingCalculator.Input(id, EvidenceTier.T1, EvidenceKind.POINT, "EXAM", "form-" + id, observed, 1.0, at);
    }

    private SkillRatingCalculator.Input t3(String module, String material, int observed, EvidenceKind kind, Instant at) {
        return new SkillRatingCalculator.Input(ids++, EvidenceTier.T3, kind, module, material, observed, 0.35, at);
    }

    private static Instant ago(double days) {
        return NOW.minus(Duration.ofMinutes((long) (days * 24 * 60)));
    }

    private static double baseSum(List<SkillRatingCalculator.Weighted> ws) {
        return ws.stream().mapToDouble(SkillRatingCalculator.Weighted::base).sum();
    }

    @Test
    @DisplayName("Mass caps: 30 distinct dictations in one bucket ⇒ module total capped at 1.2 (never above)")
    void perModuleCap() {
        List<SkillRatingCalculator.Input> ev = new ArrayList<>();
        for (int i = 0; i < 30; i++) ev.add(t3("DICTATION", "ex-" + i, 499, EvidenceKind.LOWER_BOUND, ago(1 + i * 0.01)));
        assertEquals(1.2, baseSum(calc.basesAfterRepeatsAndCaps(ev)), 1e-9);
        SkillRatingCalculator.Result r = calc.calculate(ProficiencySkill.LISTENING, ev, NOW, false);
        assertTrue(r.weightSum() <= 1.2 + 1e-9);
    }

    @Test
    @DisplayName("Mass caps: two T3 modules (30 + 30) in one bucket ⇒ skill total capped at 2.0, each module ≤ 1.2")
    void perSkillCap() {
        List<SkillRatingCalculator.Input> ev = new ArrayList<>();
        for (int i = 0; i < 30; i++) ev.add(t3("DICTATION", "ex-" + i, 499, EvidenceKind.POINT, ago(1)));
        for (int i = 0; i < 30; i++) ev.add(t3("SECOND_T3_MODULE", "m-" + i, 499, EvidenceKind.POINT, ago(1)));
        List<SkillRatingCalculator.Weighted> bases = calc.basesAfterRepeatsAndCaps(ev);
        assertEquals(2.0, baseSum(bases), 1e-9);
        double dictation = bases.stream().filter(w -> w.input().sourceModule().equals("DICTATION"))
                .mapToDouble(SkillRatingCalculator.Weighted::base).sum();
        assertTrue(dictation <= 1.2 + 1e-9);
    }

    @Test
    @DisplayName("T1 anchor: IELTS Listening 750-equivalent + 20 B2 dictations at 0.95 ⇒ rating stays 750")
    void t1Anchor() {
        List<SkillRatingCalculator.Input> ev = new ArrayList<>();
        ev.add(t1(750, ago(2)));
        for (int i = 0; i < 20; i++) ev.add(t3("DICTATION", "ex-" + i, 666, EvidenceKind.LOWER_BOUND, ago(1)));
        assertEquals(750, calc.calculate(ProficiencySkill.LISTENING, ev, NOW, false).rating());
    }

    @Test
    @DisplayName("Only T3 evidence (any amount) ⇒ at most PROVISIONAL")
    void onlyT3IsProvisional() {
        List<SkillRatingCalculator.Input> ev = new ArrayList<>();
        for (int b = 0; b < 10; b++) {
            for (int i = 0; i < 30; i++) ev.add(t3("DICTATION", "ex-" + b + "-" + i, 499, EvidenceKind.POINT, ago(1 + b * 30)));
        }
        SkillRatingCalculator.Result r = calc.calculate(ProficiencySkill.LISTENING, ev, NOW, false);
        assertEquals(SkillStatus.PROVISIONAL, r.status());
        assertTrue(r.confidence() > 0.0);
    }

    @Test
    @DisplayName("Repeat of the same material_key ⇒ stored, base weight 0 (repeatWeight default 0)")
    void repeatsWeighZero() {
        List<SkillRatingCalculator.Input> ev = List.of(
                t3("DICTATION", "ex-1", 499, EvidenceKind.POINT, ago(3)),
                t3("DICTATION", "ex-1", 499, EvidenceKind.POINT, ago(2)));
        List<SkillRatingCalculator.Weighted> bases = calc.basesAfterRepeatsAndCaps(ev);
        assertEquals(2, bases.size());
        assertEquals(0.35, bases.get(0).base(), 1e-9);
        assertEquals(0.0, bases.get(1).base(), 1e-9);
    }

    @Test
    @DisplayName("Rating is a weighted mean, never a max")
    void weightedMean() {
        List<SkillRatingCalculator.Input> ev = List.of(t1(400, ago(5)), t1(600, ago(5)));
        assertEquals(500, calc.calculate(ProficiencySkill.READING, ev, NOW, false).rating());
    }

    @Test
    @DisplayName("Time invariance with caps active: all evidence 60 days older ⇒ same rating, lower confidence")
    void timeInvariance() {
        List<SkillRatingCalculator.Input> fresh = new ArrayList<>();
        fresh.add(t1(700, ago(10)));
        fresh.add(t1(560, ago(40)));
        for (int i = 0; i < 25; i++) fresh.add(t3("DICTATION", "ex-" + i, 416, EvidenceKind.POINT, ago(3 + i * 0.1)));
        for (int i = 0; i < 25; i++) fresh.add(t3("DICTATION", "ey-" + i, 300, EvidenceKind.POINT, ago(50 + i * 0.1)));
        List<SkillRatingCalculator.Input> older = fresh.stream().map(e -> new SkillRatingCalculator.Input(e.id(), e.tier(),
                e.kind(), e.sourceModule(), e.materialKey(), e.observedRating(), e.tierWeight(),
                e.occurredAt().minus(Duration.ofDays(60)))).toList();

        SkillRatingCalculator.Result a = calc.calculate(ProficiencySkill.LISTENING, fresh, NOW, false);
        SkillRatingCalculator.Result b = calc.calculate(ProficiencySkill.LISTENING, older, NOW, false);
        assertEquals(a.rating(), b.rating());
        assertTrue(b.weightSum() < a.weightSum());
        assertTrue(b.confidence() < a.confidence());
    }

    @Test
    @DisplayName("Nightly refresh never changes the stored rating")
    void refreshKeepsRating() {
        List<SkillRatingCalculator.Input> ev = List.of(t1(600, ago(5)), t1(640, ago(5)));
        SkillRatingCalculator.Result r = calc.refresh(ProficiencySkill.READING, ev, NOW.plus(Duration.ofDays(200)), true, 620, 20.0);
        assertEquals(620, r.rating());
        assertEquals(20.0, r.sd());
    }

    // ---- §6 status precedence: one case per branch ----------------------------------------------

    @Test
    @DisplayName("Status UNSUPPORTED: disabled skill (VOCABULARY)")
    void statusUnsupported() {
        SkillRatingCalculator.Result r = calc.calculate(ProficiencySkill.VOCABULARY, List.of(t1(700, ago(1)), t1(700, ago(1))), NOW, false);
        assertEquals(SkillStatus.UNSUPPORTED, r.status());
        assertNull(r.rating());
    }

    @Test
    @DisplayName("Status STALE: previously VERIFIED and newest valid evidence older than 120 days")
    void statusStale() {
        List<SkillRatingCalculator.Input> ev = List.of(t1(650, ago(130)), t1(650, ago(131)));
        assertEquals(SkillStatus.STALE, calc.calculate(ProficiencySkill.READING, ev, NOW, true).status());
        assertNotEquals(SkillStatus.STALE, calc.calculate(ProficiencySkill.READING, ev, NOW, false).status(),
                "never-verified skills cannot be STALE");
        List<SkillRatingCalculator.Input> ancient = List.of(t1(650, ago(400)), t1(650, ago(401)));
        assertEquals(SkillStatus.STALE, calc.calculate(ProficiencySkill.READING, ancient, NOW, true).status(),
                "STALE even when every evidence row is older than 365 days");
    }

    @Test
    @DisplayName("Status UNDETERMINED: fewer than 2 evidence rows with b > 0")
    void statusUndetermined() {
        assertEquals(SkillStatus.UNDETERMINED, calc.calculate(ProficiencySkill.READING, List.of(t1(650, ago(1))), NOW, false).status());
        List<SkillRatingCalculator.Input> repeats = List.of(
                t3("DICTATION", "ex-1", 499, EvidenceKind.POINT, ago(2)), t3("DICTATION", "ex-1", 499, EvidenceKind.POINT, ago(1)));
        assertEquals(SkillStatus.UNDETERMINED, calc.calculate(ProficiencySkill.LISTENING, repeats, NOW, false).status());
    }

    @Test
    @DisplayName("Status VERIFIED: T1 within 365 days and confidence ≥ 0.60")
    void statusVerified() {
        SkillRatingCalculator.Result r = calc.calculate(ProficiencySkill.READING, List.of(t1(650, ago(1)), t1(650, ago(1))), NOW, false);
        assertEquals(SkillStatus.VERIFIED, r.status());
        assertTrue(r.confidence() >= 0.60);
        assertTrue(r.everVerified());
    }

    @Test
    @DisplayName("Status PROVISIONAL: determined but confidence < 0.60")
    void statusProvisional() {
        List<SkillRatingCalculator.Input> ev = List.of(t1(650, ago(1)), t3("DICTATION", "ex-1", 600, EvidenceKind.POINT, ago(1)));
        SkillRatingCalculator.Result r = calc.calculate(ProficiencySkill.LISTENING, ev, NOW, false);
        assertEquals(SkillStatus.PROVISIONAL, r.status());
        assertTrue(r.confidence() < 0.60);
    }

    @Test
    @DisplayName("Phase 2.1 T2: never VERIFIED, not subject to T3 mass caps, ignored by the T1 anchor")
    void t2Tier() {
        List<SkillRatingCalculator.Input> t2s = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            t2s.add(new SkillRatingCalculator.Input(ids++, EvidenceTier.T2, EvidenceKind.POINT, "EXAM", "pilot-" + i, 700, 0.7, ago(1)));
        }
        assertEquals(4.2, baseSum(calc.basesAfterRepeatsAndCaps(t2s)), 1e-9, "6 × 0.7, no cap");
        SkillRatingCalculator.Result onlyT2 = calc.calculate(ProficiencySkill.READING, t2s, NOW, false);
        assertTrue(onlyT2.confidence() >= 0.60);
        assertEquals(SkillStatus.PROVISIONAL, onlyT2.status());
        assertFalse(onlyT2.everVerified());

        // anchor r1 uses T1 only: T1 660 (w≈1) + T2 700 (w≈0.7) ⇒ (660 + 490) / 1.7 ≈ 676, T2 never zeroed
        List<SkillRatingCalculator.Input> mixed = List.of(t1(660, ago(1)),
                new SkillRatingCalculator.Input(ids++, EvidenceTier.T2, EvidenceKind.POINT, "EXAM", "pilot-x", 700, 0.7, ago(1)));
        SkillRatingCalculator.Result r = calc.calculate(ProficiencySkill.READING, mixed, NOW, false);
        assertEquals(676, r.rating());
        assertEquals(SkillStatus.VERIFIED, r.status());
    }

    @Test
    @DisplayName("Confidence formula: (1 − e^(−W/1.5)) × max(0.5, 1 − sd/300), 2 decimals")
    void confidenceFormula() {
        assertEquals(0.74, calc.confidence(2.0, 0.0), 1e-9);   // 1 − e^-1.333 = 0.736
        assertEquals(0.37, calc.confidence(2.0, 300.0), 1e-9); // sd floor 0.5
        assertEquals(0.0, calc.confidence(0.0, 0.0), 1e-9);
    }
}
