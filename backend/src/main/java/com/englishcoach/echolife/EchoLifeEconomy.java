package com.englishcoach.echolife;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.util.*;

/**
 * Echo Life — the server's economy table ({@code classpath:echo-life/economy.json}), generated from the vendored V3/V2 rules
 * by {@code frontend/scripts/build-echo-life-economy.mjs}: unique rewards (missions, side arcs, story-choice options,
 * landmarks, keepsakes), mission prerequisites, shop catalogue prices, market product prices, V3's anti-exploit caps and the
 * skill thresholds. Read once at start; immutable.
 */
@Component
public class EchoLifeEconomy {

    public record Reward(int credits, Map<String, Integer> xp) {
        int xpTotal() {
            return xp.values().stream().mapToInt(Integer::intValue).sum();
        }
    }

    public record Item(String storeId, String sku, int price, String itemType, int reqLevel, Map<String, Integer> reqSkill) {
    }

    static final double MAX_STANDING_DISCOUNT = 0.10;
    static final Set<String> DISTRICTS = Set.of("market", "bistro", "cafe", "library", "park", "campus");

    final int startingCredits, maxBalance, dailyActivityCredits, reportActivityCredits, dailyActivityXp, reportActivityXp;
    final double resaleRatio, marketSaleFactor, maxDiscountRate;
    final List<String> skills;
    final int[] thresholds;
    final Set<Integer> saleDays;
    final int saleStart, saleEnd;
    final double[][] discount;
    final Map<String, Reward> uniques;
    final Map<String, List<String>> missionRequires;
    final Map<String, Integer> products;
    final Map<String, Integer> bistroMenu;
    final Map<String, Map<String, Item>> shops;

    public EchoLifeEconomy(ObjectMapper json) throws IOException {
        try (InputStream in = new ClassPathResource("echo-life/economy.json").getInputStream()) {
            JsonNode t = json.readTree(in);
            startingCredits = t.path("startingCredits").asInt(120);
            maxBalance = t.path("maxBalance").asInt(10_000_000);
            dailyActivityCredits = t.path("dailyActivityCredits").asInt();
            reportActivityCredits = t.path("reportActivityCredits").asInt();
            dailyActivityXp = t.path("dailyActivityXp").asInt();
            reportActivityXp = t.path("reportActivityXp").asInt();
            resaleRatio = t.path("resaleRatio").asDouble(.6);
            marketSaleFactor = t.path("marketSaleFactor").asDouble(.8);
            JsonNode sale = t.required("marketEvent");
            Set<Integer> days = new HashSet<>();
            sale.required("days").forEach(day -> days.add(day.intValue()));
            saleDays = Set.copyOf(days);
            saleStart = sale.required("startHour").intValue();
            saleEnd = sale.required("endHour").intValue();
            List<String> sk = new ArrayList<>();
            t.path("skills").forEach(n -> sk.add(n.asText()));
            skills = List.copyOf(sk);
            JsonNode th = t.path("skillThresholds");
            thresholds = new int[th.size()];
            for (int i = 0; i < th.size(); i++) thresholds[i] = th.get(i).asInt();
            JsonNode d = t.path("discount");
            discount = new double[d.size()][2];
            double ceiling = 0.15;
            for (int i = 0; i < d.size(); i++) {
                discount[i] = new double[]{d.get(i).get(0).asDouble(), d.get(i).get(1).asDouble()};
                ceiling = Math.max(ceiling, discount[i][1]);
            }
            maxDiscountRate = ceiling;
            Map<String, Reward> u = new HashMap<>();
            t.path("uniques").fields().forEachRemaining(e -> {
                Map<String, Integer> xp = new HashMap<>();
                e.getValue().path("xp").fields().forEachRemaining(x -> xp.put(x.getKey(), x.getValue().asInt()));
                u.put(e.getKey(), new Reward(e.getValue().path("credits").asInt(), Map.copyOf(xp)));
            });
            uniques = Map.copyOf(u);
            Map<String, List<String>> req = new HashMap<>();
            t.path("missionRequires").fields().forEachRemaining(e -> {
                List<String> r = new ArrayList<>();
                e.getValue().forEach(n -> r.add(n.asText()));
                req.put(e.getKey(), List.copyOf(r));
            });
            missionRequires = Map.copyOf(req);
            Map<String, Integer> pr = new HashMap<>();
            t.path("products").fields().forEachRemaining(e -> pr.put(e.getKey(), e.getValue().asInt()));
            products = Map.copyOf(pr);
            // Server-authoritative 5-item Willow Bistro menu (preserving existing matcha_crepe = 12 credits).
            Map<String, Integer> bm = new LinkedHashMap<>();
            bm.put("matcha_crepe", 12);
            bm.put("iced_matcha", 9);
            bm.put("egg_banh_mi", 10);
            bm.put("truffle_ramen", 18);
            bm.put("jasmine_tea_set", 14);
            if (t.has("bistroMenu") && t.get("bistroMenu").isObject()) {
                t.get("bistroMenu").fields().forEachRemaining(e -> {
                    if (e.getValue().isInt() && e.getValue().asInt() >= 1) bm.put(e.getKey(), e.getValue().asInt());
                });
            }
            bistroMenu = Map.copyOf(bm);
            Map<String, Map<String, Item>> sh = new HashMap<>();
            t.path("shops").fields().forEachRemaining(store -> {
                Map<String, Item> items = new HashMap<>();
                store.getValue().fields().forEachRemaining(i -> {
                    Map<String, Integer> rs = new HashMap<>();
                    i.getValue().path("reqSkill").fields().forEachRemaining(x -> rs.put(x.getKey(), x.getValue().asInt()));
                    items.put(i.getKey(), new Item(store.getKey(), i.getKey(), i.getValue().path("price").asInt(),
                            i.getValue().path("itemType").asText(), i.getValue().path("reqLevel").asInt(1), Map.copyOf(rs)));
                });
                sh.put(store.getKey(), Map.copyOf(items));
            });
            shops = Map.copyOf(sh);
        }
    }

    int skillLevel(int xp) {
        int lv = 1;
        for (int i = 1; i < thresholds.length; i++) if (xp >= thresholds[i]) lv = i + 1;
        return lv;
    }

    /** V3 `xpRequiredForPlayerLevel` / `playerLevelFromXp` (max level 30). */
    static int playerLevel(int totalXp) {
        int lv = 1;
        while (lv < 30 && totalXp >= Math.round(100 * Math.pow(lv, 1.35))) lv++;
        return lv;
    }

    /** V3 `getStoreDiscountRate`: by Business skill level. */
    double discountFor(int businessLevel) {
        for (double[] d : discount) if (businessLevel >= d[0]) return d[1];
        return 0;
    }

    /** Bounded server-side district standing discount (0%..10%) derived from persisted district reputation (0..100). */
    double standingDiscountFor(int districtRepScore) {
        int clamped = Math.max(0, Math.min(100, districtRepScore));
        if (clamped >= 85) return MAX_STANDING_DISCOUNT;
        if (clamped >= 60) return 0.08;
        if (clamped >= 30) return 0.05;
        return 0.0;
    }

    /** Bounded business-skill standing fallback for bistro hospitality (0%..8%, always <= MAX_STANDING_DISCOUNT). */
    double standingFromBusiness(int businessLevel) {
        if (businessLevel >= 6) return 0.08;
        if (businessLevel >= 4) return 0.05;
        if (businessLevel >= 2) return 0.03;
        return 0.0;
    }

    /** Combined shop discount capped strictly at the existing server discount ceiling ({@code maxDiscountRate}, 15%). */
    double combinedShopDiscount(int businessLevel, double standingRate) {
        double safeStanding = Double.isFinite(standingRate)
                ? Math.max(0.0, Math.min(MAX_STANDING_DISCOUNT, standingRate))
                : 0.0;
        return Math.min(maxDiscountRate, discountFor(businessLevel) + safeStanding);
    }

    /** Maps a store or zone ID to its canonical neighborhood district reputation bucket. */
    static String resolveDistrict(String zoneOrStore) {
        if (zoneOrStore == null) return "market";
        if (DISTRICTS.contains(zoneOrStore)) return zoneOrStore;
        return switch (zoneOrStore) {
            case "bistro" -> "bistro";
            case "cafe", "linh", "minh" -> "cafe";
            case "library" -> "library";
            case "park", "botanical", "greenway", "atelier", "lantern_garden", "fair" -> "park";
            case "campus", "fountain_plaza" -> "campus";
            default -> "market";
        };
    }

    Optional<Integer> bistroPrice(String item) {
        return Optional.ofNullable(bistroMenu.get(item));
    }

    Map<String, Integer> bistroMenu() {
        return bistroMenu;
    }

    Optional<Item> item(String storeId, String sku) {
        return Optional.ofNullable(shops.getOrDefault(storeId, Map.of()).get(sku));
    }
}
