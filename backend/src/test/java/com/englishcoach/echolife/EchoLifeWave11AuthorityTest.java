package com.englishcoach.echolife;

import com.englishcoach.common.AvatarLookCode;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Wave 11 Team C1 unit tests (no Docker required):
 * <ul>
 *   <li>All 7 jobs in {@code echo-life/rules.js} (including {@code gardener}, {@code busker} sunny &amp; rainy {@code atelier}),
 *       validated {@code quality} multipliers &amp; hard cap, {@code careerTiers} 1..5 bonuses &amp; 1.45x combined cap,
 *       and 1500 ms anti-speedhack cooldown.</li>
 *   <li>Fail-closed {@code EchoLifeService} Character Creator {@code avatar} validation &amp; server-computed V2 {@code wireCode}.</li>
 *   <li>Willow Bistro 5-item menu, server district standing discounts capped at ceiling, and {@code worldV3.lifeMeta} (32 KB) validation.</li>
 * </ul>
 */
class EchoLifeWave11AuthorityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static ObjectNode workshopInput(JsonNode previous, int credits, long serverNow, int shiftAllowance, ObjectNode action) {
        ObjectNode input = JSON.createObjectNode();
        input.put("owner", "u42");
        input.put("credits", credits);
        ObjectNode skills = input.putObject("skills");
        for (String s : List.of("technology", "cooking", "diy_design", "business", "social", "mobility")) {
            skills.put(s, 0);
        }
        input.putArray("owned");
        input.putArray("claimed");
        if (previous != null) input.set("previous", previous);
        input.put("serverNow", serverNow);
        input.put("shiftAllowance", shiftAllowance);
        input.set("action", action);
        return input;
    }

    private static ObjectNode jobStep(String jobId, String zoneId, String station, String quality) {
        ObjectNode a = JSON.createObjectNode()
                .put("type", "job_step")
                .put("jobId", jobId)
                .put("zoneId", zoneId)
                .put("station", station);
        if (quality != null) a.put("quality", quality);
        return a;
    }

    private static JsonNode runFullShift(JsonNode previous, int credits, long startNow, int allowance,
                                         String jobId, List<String[]> steps, String finalQuality) {
        JsonNode prog = previous;
        int curCredits = credits;
        long now = startNow;
        JsonNode last = null;
        for (int i = 0; i < steps.size(); i++) {
            if (i > 0) now += 1600;
            String q = (i == steps.size() - 1) ? finalQuality : null;
            ObjectNode action = jobStep(jobId, steps.get(i)[0], steps.get(i)[1], q);
            EchoLifeWorkshop.validate(action);
            last = EchoLifeWorkshop.run(JSON, workshopInput(prog, curCredits, now, allowance, action));
            assertThat(last.path("ok").asBoolean()).as("job %s step %d: %s", jobId, i, last.path("msg").asText()).isTrue();
            prog = last.path("progression");
            curCredits = last.path("credits").asInt();
        }
        return last;
    }

    // ── 1. All 7 Jobs, Rainy Fallback, Quality Cap, Anti-Speedhack, Career Tiers ─────────────────────────────

    @Test
    void allSevenJobsCompleteThroughPackagedRulesIncludingGardenerAndBuskerRainFallback() {
        Map<String, List<String[]>> allJobs = Map.of(
                "market", List.of(
                        new String[]{"market", "market_shift"},
                        new String[]{"market", "shelf"},
                        new String[]{"market", "tea"},
                        new String[]{"market", "till"}),
                "barista", List.of(
                        new String[]{"bistro", "bistro_espresso"},
                        new String[]{"bistro", "bistro_counter"},
                        new String[]{"bistro", "bistro_espresso"},
                        new String[]{"bistro", "bistro_booth_a"}),
                "delivery", List.of(
                        new String[]{"street", "courier_board"},
                        new String[]{"market", "shelf"},
                        new String[]{"greenway", "greenway_checkpoint_a"}),
                "library", List.of(
                        new String[]{"library", "lib_catalog"},
                        new String[]{"library", "lib_stacks_l"},
                        new String[]{"library", "lib_table_a"},
                        new String[]{"library", "lib_catalog"}),
                "cafe", List.of(
                        new String[]{"cafe", "tech_bench"},
                        new String[]{"cafe", "console"},
                        new String[]{"cafe", "screen"},
                        new String[]{"cafe", "tech_bench"}),
                "gardener", List.of(
                        new String[]{"botanical", "bot_gazebo"},
                        new String[]{"botanical", "bot_bed_a"},
                        new String[]{"botanical", "bot_bed_b"},
                        new String[]{"botanical", "bot_can"}),
                "busker", List.of(
                        new String[]{"fountain_plaza", "plaza_stage"},
                        new String[]{"fountain_plaza", "old_fountain"},
                        new String[]{"fountain_plaza", "plaza_stage"})
        );
        Map<String, Integer> basePay = Map.of(
                "market", 45, "barista", 60, "delivery", 75,
                "library", 55, "cafe", 65, "gardener", 55, "busker", 60);

        for (var entry : allJobs.entrySet()) {
            JsonNode done = runFullShift(null, 100, 1_000_000L, 900, entry.getKey(), entry.getValue(), "ok");
            assertThat(done.path("credits").asInt()).as("job %s base pay", entry.getKey()).isEqualTo(100 + basePay.get(entry.getKey()));
            JsonNode tier = done.at("/progression/careerTiers/" + entry.getKey());
            assertThat(tier.path("shifts").asInt()).isEqualTo(1);
            assertThat(tier.path("tier").asInt()).isEqualTo(1);
            assertThat(tier.path("bestQuality").asText()).isEqualTo("ok");
        }

        // Rainy-day fallback for Fountain Plaza Busker inside Riverside Atelier!
        List<String[]> rainyBusker = List.of(
                new String[]{"atelier", "atelier_acoustic"},
                new String[]{"atelier", "atelier_easel_a"},
                new String[]{"atelier", "atelier_acoustic"});
        JsonNode rainDone = runFullShift(null, 100, 2_000_000L, 900, "busker", rainyBusker, "perfect");
        assertThat(rainDone.path("credits").asInt()).isEqualTo(100 + Math.round(60 * 1.25f)); // 175
        assertThat(rainDone.at("/progression/careerTiers/busker/bestQuality").asText()).isEqualTo("perfect");
    }

    @Test
    void shiftQualityMultipliersAntiSpeedhackCooldownAndCareerTierCapsAreServerAuthoritative() {
        List<String[]> buskerSteps = List.of(
                new String[]{"fountain_plaza", "plaza_stage"},
                new String[]{"fountain_plaza", "old_fountain"},
                new String[]{"fountain_plaza", "plaza_stage"});

        // Quality multipliers on tier 1 (base 60): ok=60, great=67, perfect=75 (<= Math.round(60 * 1.25) = 75)
        assertThat(runFullShift(null, 0, 10_000L, 900, "busker", buskerSteps, "ok").path("credits").asInt()).isEqualTo(60);
        assertThat(runFullShift(null, 0, 10_000L, 900, "busker", buskerSteps, "great").path("credits").asInt()).isEqualTo(67);
        assertThat(runFullShift(null, 0, 10_000L, 900, "busker", buskerSteps, "perfect").path("credits").asInt()).isEqualTo(75);

        // Invalid quality string rejected by EchoLifeWorkshop.validate()
        for (String badQuality : List.of("ultra", "godmode", "999", "constructor", "")) {
            ObjectNode bad = jobStep("busker", "fountain_plaza", "plaza_stage", badQuality);
            assertThatThrownBy(() -> EchoLifeWorkshop.validate(bad))
                    .isInstanceOf(EchoLifeException.class)
                    .hasMessage("INVALID_PROGRESSION_ACTION");
        }
        // Quality on non-job_step rejected
        ObjectNode nonJobQuality = JSON.createObjectNode().put("type", "undo_build").put("quality", "perfect");
        assertThatThrownBy(() -> EchoLifeWorkshop.validate(nonJobQuality))
                .isInstanceOf(EchoLifeException.class)
                .hasMessage("INVALID_PROGRESSION_ACTION");

        // 1500 ms anti-speedhack cooldown enforced
        JsonNode step0 = EchoLifeWorkshop.run(JSON, workshopInput(null, 0, 50_000L, 900,
                jobStep("busker", "fountain_plaza", "plaza_stage", null)));
        assertThat(step0.path("ok").asBoolean()).isTrue();
        JsonNode tooFast = EchoLifeWorkshop.run(JSON, workshopInput(step0.path("progression"), 0, 51_499L, 900,
                jobStep("busker", "fountain_plaza", "old_fountain", null)));
        assertThat(tooFast.path("ok").asBoolean()).isFalse();
        assertThat(tooFast.path("msg").asText()).contains("Finish moving");

        // Career tiers progression across 19 shifts -> tier 1..5 and combined cap <= 1.45x (60 * 1.45 = 87)
        JsonNode prog = null;
        int credits = 0;
        long clock = 100_000L;
        int[] expectedTiersAfter = {1, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5};
        int lastDelta = 0;
        for (int s = 0; s < 19; s++) {
            int before = credits;
            String q = (s == 0) ? "ok" : (s == 1) ? "great" : "perfect";
            JsonNode done = runFullShift(prog, credits, clock, 900, "busker", buskerSteps, q);
            prog = done.path("progression");
            credits = done.path("credits").asInt();
            lastDelta = credits - before;
            assertThat(prog.at("/careerTiers/busker/shifts").asInt()).isEqualTo(s + 1);
            assertThat(prog.at("/careerTiers/busker/tier").asInt()).isEqualTo(expectedTiersAfter[s]);
            clock += 20_000L;
        }
        // On shift #19 (started at tier 5 = +20% bonus, perfect = 1.25x -> combined 1.45x cap -> 87 credits)
        assertThat(lastDelta).isEqualTo(Math.round(60 * 1.45f));
        assertThat(prog.at("/careerTiers/busker/bestQuality").asText()).isEqualTo("perfect");
    }

    // ── 2. EchoLifeService Strict Avatar Validation ──────────────────────────────────────────────────────────

    private static ObjectNode validAvatar() {
        ObjectNode av = JSON.createObjectNode();
        av.put("version", 2);
        av.put("hero", "LYRA");
        av.put("hairId", "long_wave");
        av.put("hairColor", "#40303F");
        av.put("hairTipColor", "#7C6CF0");
        av.put("hairTipMix", 0.35);
        av.put("skinTone", "#CB9578");
        av.put("irisColor", "#4A6B8C");
        av.put("lipColor", "#B86B77");
        ObjectNode face = av.putObject("face");
        face.put("jawWidth", 0.15).put("eyeSize", 0.25).put("noseBridge", -0.1).put("lipFullness", 0.2);
        face.putObject("makeup").put("blush", 0.3).put("lip", 0.4).put("freckles", 0.15).put("brow", "arched").put("facialHair", "none");
        av.putObject("body")
                .put("heightScale", 1.02)
                .put("buildScale", 0.98)
                .put("shoulderWidth", 1.0)
                .put("legRatio", 1.03)
                .put("torsoDepth", 0.97)
                .put("hipWidth", 1.01);
        ArrayNode outfits = av.putArray("outfits");
        ObjectNode o0 = outfits.addObject();
        o0.put("slot", "everyday").put("name", "Campus Autumn Look");
        o0.put("top", "hoodie").put("outerwear", "trench_coat").put("bottom", "jeans").put("shoes", "sneakers");
        o0.putArray("accessories").add("glasses").add("headphones");
        o0.putObject("colors").put("top", "#2F3A55").put("bottom", "#2C3E5E").put("shoes", "#F2EFE6").put("accessory", "#3B3F55");
        o0.putObject("fabrics").put("top", "fleece").put("bottom", "denim").put("outerwear", "wool");
        o0.putObject("patterns").put("top", "solid").put("outerwear", "plaid");
        av.put("activeOutfit", 0);
        av.put("autoSeasonalOutfit", true);
        ObjectNode id = av.putObject("identity");
        id.putArray("traitIds").add("curious").add("creative");
        id.put("desiredLifeId", "scholar_creator");
        id.putArray("values").add("kindness").add("growth");
        id.putArray("favorites").add("matcha").add("rainy_days");
        av.put("at", 1_700_000_000_000L);
        return av;
    }

    private static ObjectNode worldWithAvatar(ObjectNode avatar) {
        ObjectNode state = EchoLifeService.emptyState();
        state.set("avatar", avatar);
        return state;
    }

    @Test
    void validFullCharacterCreatorAvatarPassesAndComputesServerWireCode() {
        EchoLifeService svc = new EchoLifeService(mock(EchoLifeRepository.class));
        ObjectNode normalized = svc.normalize(worldWithAvatar(validAvatar()), Set.of(UUID.randomUUID()));
        JsonNode av = normalized.get("avatar");
        assertThat(av).isNotNull();
        assertThat(av.path("hairColor").asText()).isEqualTo("#40303f");
        assertThat(av.path("skinTone").asText()).isEqualTo("#cb9578");
        String wireCode = av.path("wireCode").asText();
        assertThat(AvatarLookCode.isV2(wireCode)).isTrue();
        assertThat(AvatarLookCode.clean(wireCode)).isEqualTo(wireCode);
        assertThat(wireCode).startsWith("v2:l:long_wave:cb9578:4a6b8c:");
    }

    @Test
    void avatarRejectsUrlInjectionOutOfRangeSlidersUnknownKeysAndOversizedPayloads() {
        EchoLifeService svc = new EchoLifeService(mock(EchoLifeRepository.class));

        // URL injection in wireCode
        ObjectNode urlWire = validAvatar().put("wireCode", "https://evil.example/avatar.glb");
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(urlWire), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Script injection in outfit name
        ObjectNode xssName = validAvatar();
        ((ObjectNode) xssName.get("outfits").get(0)).put("name", "<script>alert(1)</script>");
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(xssName), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Path traversal in hairId
        ObjectNode traversalHair = validAvatar().put("hairId", "../../etc/passwd");
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(traversalHair), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Out-of-range face morph (> 1.0)
        ObjectNode badFace = validAvatar();
        ((ObjectNode) badFace.get("face")).put("jawWidth", 1.5);
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(badFace), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Out-of-range body slider (heightScale > 1.12)
        ObjectNode badBody = validAvatar();
        ((ObjectNode) badBody.get("body")).put("heightScale", 1.50);
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(badBody), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Unknown top-level key inside avatar
        ObjectNode unknownKey = validAvatar().put("modelUrl", "https://evil.example/x.glb");
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(unknownKey), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Unallowlisted fabric
        ObjectNode badFabric = validAvatar();
        ((ObjectNode) badFabric.get("outfits").get(0).get("fabrics")).put("top", "unobtainium");
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(badFabric), Set.of()))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_WORLD");

        // Oversized avatar > 24 KB -> 413 AVATAR_TOO_LARGE
        ObjectNode huge = validAvatar();
        huge.put("hairId", "a".repeat(25_000));
        assertThatThrownBy(() -> svc.normalize(worldWithAvatar(huge), Set.of()))
                .isInstanceOf(EchoLifeException.class)
                .satisfies(ex -> assertThat(((EchoLifeException) ex).status).isEqualTo(413));
    }

    // ── 3. EchoLifeEconomy Bistro Menu, Standing Discount Cap, and LifeMeta Validation ───────────────────────

    @Test
    void economyExposesFiveItemBistroMenuAndCapsCombinedDiscountAtServerCeiling() throws Exception {
        EchoLifeEconomy eco = new EchoLifeEconomy(JSON);
        assertThat(eco.bistroMenu()).containsExactlyInAnyOrderEntriesOf(Map.of(
                "matcha_crepe", 12,
                "iced_matcha", 9,
                "egg_banh_mi", 10,
                "truffle_ramen", 18,
                "jasmine_tea_set", 14));

        // Standing discount strictly bounded 0..10%
        assertThat(eco.standingDiscountFor(-50)).isEqualTo(0.0);
        assertThat(eco.standingDiscountFor(29)).isEqualTo(0.0);
        assertThat(eco.standingDiscountFor(30)).isEqualTo(0.05);
        assertThat(eco.standingDiscountFor(60)).isEqualTo(0.08);
        assertThat(eco.standingDiscountFor(85)).isEqualTo(0.10);
        assertThat(eco.standingDiscountFor(9999)).isEqualTo(0.10);

        // Combined shop discount never exceeds server ceiling (0.15)
        assertThat(eco.combinedShopDiscount(1, 0.08)).isEqualTo(0.08);
        assertThat(eco.combinedShopDiscount(2, 0.0)).isEqualTo(0.05);
        assertThat(eco.combinedShopDiscount(8, 0.10)).isEqualTo(0.15);
        assertThat(eco.combinedShopDiscount(10, 0.99)).isEqualTo(0.15);
    }

    @Test
    void gameDocValidationAcceptsRichLifeMetaUpTo32KbAndRejectsEconomyForgeryOrOverflow() throws Exception {
        EchoLifeGameRepository repo = mock(EchoLifeGameRepository.class);
        when(repo.owned(7L)).thenReturn(List.of());
        EchoLifeGameService svc = new EchoLifeGameService(repo, new EchoLifeEconomy(JSON), JSON);

        ObjectNode save = JSON.createObjectNode().put("version", 4).put("owner", "u7").put("clock", 720);
        ObjectNode lifeMeta = save.putObject("worldV3").putObject("lifeMeta");
        lifeMeta.put("v", 2).put("lastComfort", 78).put("karma", 45);
        lifeMeta.putArray("traits").add("curious").add("bookworm");
        lifeMeta.put("desiredLife", "scholar_creator");
        lifeMeta.putArray("urges").add("brew_tea").add("visit_library");
        lifeMeta.putObject("needs")
                .put("energy", 82).put("hunger", 74).put("hygiene", 90).put("mood", 85)
                .put("focus", 78).put("fitness", 66).put("social", 70).put("fun", 72);
        lifeMeta.putObject("emotions").put("primary", "inspired").put("intensity", 0.75);
        lifeMeta.putObject("subSkills").put("latte_art", 3).put("sketching", 2);
        lifeMeta.putArray("phoneMessages").addObject().put("from", "khanhha").put("text", "Fresh matcha crepes are ready!");
        lifeMeta.putObject("schedule").put("morning", "library");
        lifeMeta.putObject("cityConfig").put("rainFrequency", 0.3).put("crowdDensity", 0.8);
        lifeMeta.putObject("starterFurniture").put("deskColor", "#8a6d4b");
        lifeMeta.putObject("districtRep").put("bistro", 72).put("market", 45);

        ObjectNode doc = JSON.createObjectNode().put("v", 1).put("save", save.toString());
        doc.putObject("places").putObject("linh").put("x", 10.0).put("z", -5.0);

        // Valid rich Wave 11 lifeMeta passes cleanly
        svc.validate(7L, doc);

        // Forged credits inside lifeMeta -> REJECTED
        ObjectNode forgedSave = save.deepCopy();
        ((ObjectNode) forgedSave.at("/worldV3/lifeMeta")).put("credits", 999999);
        ObjectNode forgedDoc = doc.deepCopy().put("save", forgedSave.toString());
        assertThatThrownBy(() -> svc.validate(7L, forgedDoc))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_GAME");

        // Script tag inside phoneMessages -> REJECTED
        ObjectNode xssSave = save.deepCopy();
        ((ArrayNode) xssSave.at("/worldV3/lifeMeta/phoneMessages")).addObject().put("from", "x").put("text", "<script>alert(1)</script>");
        ObjectNode xssDoc = doc.deepCopy().put("save", xssSave.toString());
        assertThatThrownBy(() -> svc.validate(7L, xssDoc))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_GAME");

        // Oversized lifeMeta (> 32 KB) -> REJECTED
        ObjectNode bigSave = save.deepCopy();
        ArrayNode msgs = (ArrayNode) bigSave.at("/worldV3/lifeMeta/phoneMessages");
        for (int i = 0; i < 80; i++) {
            msgs.addObject().put("from", "linh").put("text", "a".repeat(480));
        }
        ObjectNode bigDoc = doc.deepCopy().put("save", bigSave.toString());
        assertThatThrownBy(() -> svc.validate(7L, bigDoc))
                .isInstanceOf(EchoLifeException.class).hasMessage("INVALID_GAME");
    }
}
