package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;

/** Authoritative v7 archipelago collision, topography, bathymetry, and swimming surface; strictly mirrors arenaTerrain.ts. */
final class ArenaGeometry {
    static final double WATER_Y = -1.2;
    /** Open maritime sea radius for rowboats, sampans, launches, and cruisers (> 1 km diameter sea). */
    static final double BOAT_LIMIT = 515.0;
    /** Outer walking and swimming boundary for players. */
    static final double PLAYER_LIMIT = 540.0;
    /** Buoyant surface swim support elevation (head and shoulders above WATER_Y = -1.2 m). */
    static final double SWIM_SUPPORT_Y = WATER_Y - 0.95;

    /** Wooden rowboat / skiff hull as four overlapping circles, bow first: {metres along keel (+ = bow), radius}. */
    static final double[][] HULL = {{1.52, 0.5}, {0.62, 0.72}, {-0.36, 0.72}, {-1.28, 0.55}};
    /** Coastal wooden fishing sampan hull (~5.0 m length, five overlapping circles). */
    static final double[][] SAMPAN_HULL = {{2.1, 0.48}, {1.05, 0.76}, {0.0, 0.8}, {-1.05, 0.74}, {-1.95, 0.5}};
    /** Twin-seat coastal motor launch hull (pelagic / tern). */
    static final double[][] MOTOR_HULL = {{2.83, 0.65}, {1.72, 1.04}, {0.5, 1.18}, {-0.85, 1.17}, {-2.05, 1.12}, {-2.96, 0.58}};
    /** Multi-passenger coastal cabin cruiser hull (~8.5 m length, six overlapping circles). */
    static final double[][] CRUISER_HULL = {{3.65, 0.72}, {2.35, 1.24}, {0.95, 1.38}, {-0.55, 1.38}, {-2.05, 1.32}, {-3.45, 0.78}};

    private static final double GUNWALE_Y = WATER_Y + 0.42;
    private static final double[] SLIDE = {0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI * 0.45, -Math.PI * 0.45};

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Island(String id, double x, double z, double radius, double height, double seed, double shore,
                  String profile, Double lobe3, Double lobe5, Double beachStart, Double beachEnd) {
        double lobe3Val() { return lobe3 == null ? 0.0 : lobe3; }
        double lobe5Val() { return lobe5 == null ? 0.0 : lobe5; }
        String profileVal() { return profile == null ? "outer" : profile; }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Bridge(double ax, double az, double bx, double bz, double width, double ah, double bh) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Dock(String id, String island, double ax, double az, double bx, double bz, double width, double ah, double bh) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record BoatSpec(String id, String dock, double x, double z, double yaw, String model) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Interactable(String id, String kind, String subkind, String island, double x, double z, double yaw, double range) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Obstacle(double x, double z, double radius, String kind, Double yaw) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Rock(double x, double z, double r, double h, String island) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Furniture(String id, String kind, double x, double z, double yaw, double width, double depth, double top, int seats, boolean back) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Layout(int version, List<Island> islands, List<Bridge> bridges, List<Obstacle> obstacles, List<Furniture> furniture,
                  List<Dock> docks, List<BoatSpec> boats, List<Interactable> interactables, List<Rock> rocks) {}

    record Seat(String id, double x, double z, double yaw, double y) {}
    record Landing(double x, double z, double y) {}

    static final Layout LAYOUT = load();

    private static Layout load() {
        try (var stream = ArenaGeometry.class.getResourceAsStream("/data/speaking-arena-layout.json")) {
            Layout layout = new ObjectMapper().readValue(stream, Layout.class);
            if (layout.version() != 7
                    || layout.islands() == null || layout.islands().size() != 15
                    || layout.bridges() == null || layout.bridges().size() < 2
                    || layout.docks() == null || layout.docks().size() < 11
                    || layout.boats() == null || layout.boats().size() < 14
                    || layout.rocks() == null) {
                throw new IllegalStateException("Unexpected Speaking Arena v7 layout counts");
            }
            return layout;
        } catch (Exception e) {
            throw new IllegalStateException("Speaking Arena layout unavailable", e);
        }
    }

    static double[][] hullForModel(String model) {
        if (model == null || model.isEmpty() || "skiff".equals(model)) return HULL;
        if ("sampan".equals(model)) return SAMPAN_HULL;
        if ("cruiser".equals(model)) return CRUISER_HULL;
        return MOTOR_HULL;
    }

    private static double clamp01(double v) {
        return v < 0.0 ? 0.0 : Math.min(1.0, v);
    }

    private static double smoothstep(double e0, double e1, double x) {
        if (e1 == e0) return x >= e1 ? 1.0 : 0.0;
        double t = clamp01((x - e0) / (e1 - e0));
        return t * t * (3.0 - 2.0 * t);
    }

    private static double angleDiff(double a, double b) {
        return Math.atan2(Math.sin(a - b), Math.cos(a - b));
    }

    private static double dockElevation(double ah, double bh, double t) {
        double ramp = t <= 0.12 ? 0.0 : t >= 0.76 ? 1.0 : (t - 0.12) / 0.64;
        double s = ramp * ramp * (3.0 - 2.0 * ramp);
        return ah + (bh - ah) * s;
    }

    private static double[] segment(double ax, double az, double bx, double bz, double x, double z) {
        double dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
        double t = len2 > 0 ? Math.clamp(((x - ax) * dx + (z - az) * dz) / len2, 0.0, 1.0) : 0.0;
        return new double[]{t, Math.hypot(x - ax - t * dx, z - az - t * dz)};
    }

    static double beachFactor(Island i, double angle) {
        if (i.beachStart() == null || i.beachEnd() == null) return 0.0;
        double mid = 0.5 * (i.beachStart() + i.beachEnd());
        double half = 0.5 * Math.abs(i.beachEnd() - i.beachStart());
        if (half <= 1e-6) return 0.0;
        double d = Math.abs(angleDiff(angle, mid));
        return 1.0 - smoothstep(Math.max(0.0, half - 0.14), half + 0.18, d);
    }

    /** Multi-lobe organic coastline radius where the island meets WATER_Y (-1.2 m). Identical to arenaShoreRadius. */
    static double shoreRadius(Island i, double angle) {
        double l3 = i.lobe3Val();
        double l5 = i.lobe5Val();
        double s = i.seed();
        return i.radius() * 0.885
                + i.shore()
                + l3 * i.radius() * Math.sin(angle * 3.0 + s * 1.1)
                + l5 * i.radius() * Math.cos(angle * 5.0 - s * 0.7)
                + Math.sin(angle * 7.0 + s) * 1.15
                + Math.sin(angle * 13.0 + s * 2.0) * 0.42;
    }

    private static double islandInteriorCrown(Island i, double dx, double dz, double r, double angle, double bf) {
        String profile = i.profileVal();
        double s = i.seed();
        double radial = smoothstep(4.0, 22.0, r);
        double bfR = bf * radial;
        switch (profile) {
            case "harbor" -> {
                if (r <= 31.0) return 0.0;
                double prom = 0.78 * smoothstep(31.0, 50.0, r) * (1.0 - 0.58 * bfR);
                double northTerrace = 2.82 * smoothstep(-26.0, -55.0, dz) * (1.0 - smoothstep(18.0, 46.0, Math.abs(dx + 4.0)));
                return prom + northTerrace;
            }
            case "beach" -> {
                double ridgeDist = Math.hypot(dx + 16.0, dz + 18.0);
                double undul = 0.22 * Math.sin(dx * 0.055 + s) * Math.cos(dz * 0.055 - s);
                return 0.92
                        + 1.78 * (1.0 - smoothstep(18.0, 74.0, r))
                        + 1.42 * (1.0 - smoothstep(8.0, 38.0, ridgeDist))
                        + undul;
            }
            case "karst" -> {
                double lookoutDist = Math.hypot(dx + 20.0, dz + 18.0);
                double lookoutTerrace = 5.65 * (1.0 - smoothstep(15.0, 52.0, lookoutDist));
                double micro = 0.2 * Math.sin(dx * 0.07 + s) * Math.cos(dz * 0.07 - s);
                return 1.85 * (1.0 - 0.45 * bfR) + lookoutTerrace + micro;
            }
            case "village" -> {
                double hillside = 2.15 * smoothstep(-8.0, -48.0, dx) * (1.0 - smoothstep(25.0, 62.0, Math.abs(dz)));
                double micro = 0.1 * Math.sin(dx * 0.06 + dz * 0.05 + s);
                return 1.45 * (1.0 - 0.35 * bfR) + hillside + micro;
            }
            case "mountain" -> {
                double sumDist = Math.hypot(dx + 6.0, dz + 10.0);
                double climb = 1.0 - smoothstep(12.0, 74.0, sumDist);
                double terraces = 0.22 * Math.sin(climb * Math.PI * 3.0) * climb * (1.0 - climb);
                double baseMtn = 1.4 + (i.height() - 1.4) * (climb + terraces);
                double basinDist = Math.hypot(dx - 16.0, dz - 26.0);
                double basinWeight = 1.0 - smoothstep(8.0, 19.0, basinDist);
                return baseMtn + (4.2 - baseMtn) * basinWeight * 0.82;
            }
            case "islet" -> {
                return 0.85 * (1.0 - 0.35 * bfR)
                        + Math.max(0.0, i.height() - 0.85) * (1.0 - smoothstep(3.5, i.radius() * 0.82, r))
                        + 0.12 * radial * Math.sin(angle * 4.0 + s);
            }
            default -> {
                return 1.25 * (1.0 - 0.35 * bfR)
                        + Math.max(0.0, i.height() - 1.25) * (1.0 - smoothstep(10.0, i.radius() * 0.78, r))
                        + 0.16 * Math.sin(dx * 0.075 + s);
            }
        }
    }

    private static double islandLandElevation(Island i, double dx, double dz, double r, double shoreR, double angle, double bf) {
        if ("atoll".equals(i.profileVal())) {
            double ldx = dx;
            double ldz = dz - 2.0;
            double lr = Math.hypot(ldx, ldz);
            double lAngle = Math.atan2(ldz, ldx);
            double lagoonR = 35.0 + 3.0 * Math.sin(lAngle * 3.0 + i.seed()) + 1.6 * Math.cos(lAngle * 5.0 - i.seed());
            if (lr < lagoonR) {
                double innerDist = lagoonR - lr;
                double shallow = WATER_Y - innerDist * 0.135;
                double basin = -6.1 + 0.45 * Math.sin(dx * 0.09) * Math.cos(dz * 0.09);
                double blend = smoothstep(7.0, 24.0, innerDist);
                return shallow + (basin - shallow) * blend;
            }
            double innerRise = smoothstep(0.0, 11.0, lr - lagoonR);
            double cliffW = i.shore();
            double beachW = 15.5;
            double margin = cliffW + (beachW - cliffW) * bf;
            double rimT = clamp01((shoreR - r) / Math.max(0.5, margin));
            double beachRise = rimT * (1.18 - 0.18 * rimT);
            double cliffRise = rimT * rimT * (3.0 - 2.0 * rimT);
            double outerRise = cliffRise + (beachRise - cliffRise) * bf;
            double cayCrown = i.height() + 0.34 * Math.sin(angle * 2.0 + i.seed()) + 0.14 * Math.sin(dx * 0.07 + dz * 0.06);
            return WATER_Y + (cayCrown - WATER_Y) * innerRise * outerRise;
        }

        double cliffW = i.shore();
        double beachW = Math.min(19.0, Math.max(8.5, 0.22 * i.radius()));
        double margin = cliffW + (beachW - cliffW) * bf;
        double rimT = clamp01((shoreR - r) / Math.max(0.5, margin));
        double beachRise = rimT * (1.18 - 0.18 * rimT);
        double cliffRise = rimT * rimT * (3.0 - 2.0 * rimT);
        double coastalRise = cliffRise + (beachRise - cliffRise) * bf;
        double crownY = islandInteriorCrown(i, dx, dz, r, angle, bf);
        return WATER_Y + (crownY - WATER_Y) * coastalRise;
    }

    /** Continuous terrain and seabed elevation (+16.5 m summit down to -34 m deep ocean). Identical to arenaBathymetry. */
    static double bathymetry(double x, double z) {
        if (!Double.isFinite(x) || !Double.isFinite(z)) return -34.0;
        double worldR = Math.hypot(x, z);
        double oceanTrend = -14.5 - 19.5 * smoothstep(140.0, 480.0, worldR);
        double seabedWaves = 1.55 * Math.sin(x * 0.017 + z * 0.013)
                + 1.05 * Math.cos(x * 0.029 - z * 0.023)
                + 0.5 * Math.sin(x * 0.061 + z * 0.047);
        double reefDropOff = -8.5 * smoothstep(265.0, 335.0, z) * (1.0 - smoothstep(95.0, 220.0, Math.abs(x - 18.0)));
        double base = Math.max(-35.5, oceanTrend + seabedWaves + reefDropOff);

        double best = base;
        for (var i : LAYOUT.islands()) {
            double dx = x - i.x(), dz = z - i.z();
            double maxReach = i.radius() * 1.25 + i.shore() + 56.0;
            if (Math.abs(dx) > maxReach || Math.abs(dz) > maxReach) continue;
            double r = Math.hypot(dx, dz);
            if (r > maxReach) continue;

            double angle = Math.atan2(dz, dx);
            double shoreR = shoreRadius(i, angle);
            double bf = beachFactor(i, angle);

            if (r <= shoreR) {
                return islandLandElevation(i, dx, dz, r, shoreR, angle, bf);
            }

            double seaDist = r - shoreR;
            String profile = i.profileVal();
            double shallowSlope = 0.65 + (0.122 - 0.65) * bf;
            double shelfDepth = "atoll".equals(profile) ? -4.5 : "beach".equals(profile) ? -3.8 : -6.2;
            double nearY = WATER_Y - seaDist * shallowSlope;
            double shelfBlend = smoothstep(5.0 + 9.0 * bf, 18.0 + 12.0 * bf, seaDist);
            double midY = nearY + (shelfDepth - nearY) * shelfBlend;
            double deepSpan = "atoll".equals(profile) ? 28.0 : 34.0;
            double deepBlend = smoothstep(10.0 + 6.0 * bf, deepSpan, seaDist);
            double islandSeaY = midY + (base - midY) * deepBlend;
            if (islandSeaY > best) best = islandSeaY;
        }
        return best;
    }

    static double height(double x, double z) {
        for (var b : LAYOUT.bridges()) {
            double[] p = segment(b.ax(), b.az(), b.bx(), b.bz(), x, z);
            if (p[1] <= b.width() / 2.0) {
                return b.ah() + (b.bh() - b.ah()) * p[0] + Math.sin(Math.PI * p[0]) * 0.25;
            }
        }
        for (var d : LAYOUT.docks()) {
            double[] p = segment(d.ax(), d.az(), d.bx(), d.bz(), x, z);
            if (p[1] <= d.width() / 2.0) {
                return dockElevation(d.ah(), d.bh(), p[0]);
            }
        }
        return bathymetry(x, z);
    }

    static boolean onWood(double x, double z) {
        for (var b : LAYOUT.bridges()) {
            if (segment(b.ax(), b.az(), b.bx(), b.bz(), x, z)[1] <= b.width() / 2.0) return true;
        }
        for (var d : LAYOUT.docks()) {
            if (segment(d.ax(), d.az(), d.bx(), d.bz(), x, z)[1] <= d.width() / 2.0) return true;
        }
        return false;
    }

    static final List<Seat> SEATS = LAYOUT.furniture().stream().flatMap(f ->
            java.util.stream.IntStream.range(0, f.seats()).mapToObj(i -> {
                double u = ((i + 0.5) / f.seats() - 0.5) * f.width();
                return new Seat(f.id() + "-" + i, f.x() + Math.cos(f.yaw()) * u, f.z() - Math.sin(f.yaw()) * u, f.yaw() + Math.PI, height(f.x(), f.z()) + f.top());
            })).toList();

    private static final double[][] PAVILIONS = {
            {206.0, 98.0, 1.0, bathymetry(206.0, 98.0)},
            {8.0, 278.0, 0.95, bathymetry(8.0, 278.0)},
            {-16.0, -228.0, 1.0, bathymetry(-16.0, -228.0)},
            {256.0, -196.0, 0.95, bathymetry(256.0, -196.0)},
    };

    static double floor(double x, double z) {
        double baseH = height(x, z);
        double y = baseH;
        for (double[] pav : PAVILIONS) {
            double sc = pav[2];
            double outerR = 4.2 * sc;
            double dx = x - pav[0], dz = z - pav[1];
            if (Math.abs(dx) > outerR || Math.abs(dz) > outerR) continue;
            double d = Math.hypot(dx, dz);
            if (d >= outerR) continue;
            double slabY = pav[3] + 0.245 * sc;
            double t = clamp01((outerR - d) / (0.85 * sc));
            double smoothT = t * t * (3.0 - 2.0 * t);
            y = Math.max(y, baseH + Math.max(0.0, slabY - baseH) * smoothT);
        }
        for (var f : LAYOUT.furniture()) {
            double dx = x - f.x(), dz = z - f.z();
            if (Math.abs(dx) > 5.0 || Math.abs(dz) > 5.0) continue;
            double c = Math.cos(f.yaw()), s = Math.sin(f.yaw()), u = dx * c - dz * s, v = dx * s + dz * c;
            if ("table".equals(f.kind()) ? Math.hypot(dx, dz) > f.width() / 2.0 + 0.12 : Math.abs(u) > f.width() / 2.0 + 0.12 || Math.abs(v) > f.depth() / 2.0 + 0.12) {
                continue;
            }
            y = Math.max(y, height(f.x(), f.z()) + (f.back() && v > 0.28 ? 1.2 : f.top()));
        }
        return y;
    }

    static double supportY(double x, double z) {
        return Math.max(floor(x, z), SWIM_SUPPORT_Y);
    }

    static double waterDepth(double x, double z) {
        return Math.max(0.0, WATER_Y - floor(x, z));
    }

    private static boolean solidBlocked(double x, double z) {
        for (var o : LAYOUT.obstacles()) {
            double reach = o.radius() + 0.3;
            if (Math.abs(x - o.x()) < reach && Math.abs(z - o.z()) < reach && Math.hypot(x - o.x(), z - o.z()) < reach) {
                return true;
            }
        }
        if (!onWood(x, z) && height(x, z) < WATER_Y + 0.25) {
            for (var k : LAYOUT.rocks()) {
                if (k.h() < 0.45) continue;
                double reach = k.r() * 0.72 + 0.2;
                if (Math.abs(x - k.x()) < reach && Math.abs(z - k.z()) < reach && Math.hypot(x - k.x(), z - k.z()) < reach) {
                    return true;
                }
            }
        }
        return false;
    }

    static boolean swimmable(double x, double z) {
        if (!Double.isFinite(x) || !Double.isFinite(z)) return false;
        if (Math.hypot(x, z) > PLAYER_LIMIT) return false;
        if (onWood(x, z)) return false;
        if (floor(x, z) >= WATER_Y - 0.85) return false;
        return !solidBlocked(x, z);
    }

    static boolean isSwimming(double x, double z) {
        return swimmable(x, z);
    }

    static boolean dryWalkable(double x, double z) {
        if (!Double.isFinite(x) || !Double.isFinite(z)) return false;
        if (Math.hypot(x, z) > PLAYER_LIMIT) return false;
        if (solidBlocked(x, z)) return false;
        for (var b : LAYOUT.bridges()) {
            double[] p = segment(b.ax(), b.az(), b.bx(), b.bz(), x, z);
            if (p[1] <= b.width() / 2.0 - 0.35) return true;
            if (p[1] <= b.width() / 2.0 && p[0] > 0.08 && p[0] < 0.92 && bathymetry(x, z) <= WATER_Y) {
                return false;
            }
        }
        for (var d : LAYOUT.docks()) {
            double[] p = segment(d.ax(), d.az(), d.bx(), d.bz(), x, z);
            if (p[1] <= d.width() / 2.0 - 0.28) return true;
            if (p[1] <= d.width() / 2.0 && p[0] > 0.14 && bathymetry(x, z) <= WATER_Y) {
                return false;
            }
        }
        double h = bathymetry(x, z);
        if (h <= WATER_Y) return false;
        double eps = 0.25;
        double gx = (bathymetry(x + eps, z) - bathymetry(x - eps, z)) / (2.0 * eps);
        double gz = (bathymetry(x, z + eps) - bathymetry(x, z - eps)) / (2.0 * eps);
        return Math.hypot(gx, gz) <= 0.78;
    }

    static boolean walkable(double x, double z) {
        return walkable(x, z, supportY(x, z));
    }

    static boolean walkable(double x, double z, double feet) {
        if (!Double.isFinite(x) || !Double.isFinite(z) || !Double.isFinite(feet)) return false;
        if (Math.hypot(x, z) > PLAYER_LIMIT) return false;
        double fl = floor(x, z);
        if (fl > feet + 0.105) return false;
        if (solidBlocked(x, z)) return false;

        for (var b : LAYOUT.bridges()) {
            double[] p = segment(b.ax(), b.az(), b.bx(), b.bz(), x, z);
            if (p[1] <= b.width() / 2.0 - 0.35) return true;
            if (p[1] <= b.width() / 2.0 && p[0] > 0.08 && p[0] < 0.92 && bathymetry(x, z) <= WATER_Y) {
                return false;
            }
        }
        for (var d : LAYOUT.docks()) {
            double[] p = segment(d.ax(), d.az(), d.bx(), d.bz(), x, z);
            if (p[1] <= d.width() / 2.0 - 0.28 || (p[1] <= d.width() / 2.0 && p[0] >= 0.9)) return true;
            if (p[1] <= d.width() / 2.0 && p[0] > 0.14 && bathymetry(x, z) <= WATER_Y) {
                return false;
            }
        }

        if (fl < WATER_Y - 0.85) return true;

        double eps = 0.25;
        double gx = (bathymetry(x + eps, z) - bathymetry(x - eps, z)) / (2.0 * eps);
        double gz = (bathymetry(x, z + eps) - bathymetry(x, z - eps)) / (2.0 * eps);
        if (Math.hypot(gx, gz) > 0.78 && feet <= fl + 0.08) return false;
        return true;
    }

    private static boolean canStepSub(double x, double z, double tx, double tz, double initialFeet, boolean airborne) {
        double curSupport = supportY(x, z);
        double stepFeet = airborne ? Math.max(initialFeet, curSupport) : curSupport;
        if (!walkable(tx, tz, stepFeet)) return false;
        if (!airborne && !onWood(x, z) && !onWood(tx, tz)) {
            double h0 = bathymetry(x, z);
            double h1 = bathymetry(tx, tz);
            double stepDist = Math.max(1e-4, Math.hypot(tx - x, tz - z));
            if (h1 > WATER_Y - 0.85) {
                double eps = 0.25;
                double gx = (bathymetry(tx + eps, tz) - bathymetry(tx - eps, tz)) / (2.0 * eps);
                double gz = (bathymetry(tx, tz + eps) - bathymetry(tx, tz - eps)) / (2.0 * eps);
                if (Math.hypot(gx, gz) > 0.78) return false;
            }
            if (h0 > WATER_Y + 0.25 && (h0 - h1) / stepDist > 0.72) {
                return false;
            }
        }
        return true;
    }

    static double[] step(double x, double z, double nx, double nz) {
        return step(x, z, nx, nz, supportY(x, z));
    }

    static double[] step(double x, double z, double nx, double nz, double feet) {
        boolean airborne = feet > supportY(x, z) + 0.08;
        int n = Math.max(1, (int) Math.ceil(Math.hypot(nx - x, nz - z) / 0.16));
        double dx = (nx - x) / n, dz = (nz - z) / n;
        for (int j = 0; j < n; j++) {
            if (canStepSub(x, z, x + dx, z + dz, feet, airborne)) {
                x += dx;
                z += dz;
            } else if (canStepSub(x, z, x + dx, z, feet, airborne)) {
                x += dx;
            } else if (canStepSub(x, z, x, z + dz, feet, airborne)) {
                z += dz;
            }
        }
        return new double[]{x, z};
    }

    static Landing climbOutPoint(double x, double z) {
        if (!Double.isFinite(x) || !Double.isFinite(z)) return null;
        if (onWood(x, z) || floor(x, z) >= WATER_Y - 0.25) return null;
        Landing best = null;
        double bestDist = Double.POSITIVE_INFINITY;
        for (var d : LAYOUT.docks()) {
            double[] p = segment(d.ax(), d.az(), d.bx(), d.bz(), x, z);
            if (p[0] < 0.55) continue;
            double edgeDist = Math.max(0.0, p[1] - d.width() / 2.0);
            if (edgeDist > 2.2 || edgeDist >= bestDist) continue;
            double dx = d.bx() - d.ax(), dz = d.bz() - d.az();
            double len = Math.max(1e-6, Math.hypot(dx, dz));
            double ux = dx / len, uz = dz / len;
            double nx = -uz, nz = ux;
            double along = (x - d.ax()) * ux + (z - d.az()) * uz;
            double across = (x - d.ax()) * nx + (z - d.az()) * nz;
            double landAlong = Math.clamp(along, 0.58 * len, len - 0.35);
            double inset = Math.max(0.2, d.width() / 2.0 - 0.42);
            double landAcross = Math.clamp(across, -inset, inset);
            double lx = d.ax() + ux * landAlong + nx * landAcross;
            double lz = d.az() + uz * landAlong + nz * landAcross;
            if (!dryWalkable(lx, lz)) continue;
            bestDist = edgeDist;
            best = new Landing(lx, lz, floor(lx, lz));
        }
        return best;
    }

    static String islandAt(double x, double z) {
        if (!Double.isFinite(x) || !Double.isFinite(z)) return "commons";
        String bestId = "commons";
        double bestGap = Double.POSITIVE_INFINITY;
        for (var i : LAYOUT.islands()) {
            double dx = x - i.x(), dz = z - i.z();
            double gap = Math.hypot(dx, dz) - shoreRadius(i, Math.atan2(dz, dx));
            if (gap < bestGap) {
                bestGap = gap;
                bestId = i.id();
            }
        }
        return bestId;
    }

    static boolean inReach(double x, double z, double tx, double tz) {
        for (var o : LAYOUT.obstacles()) {
            if (Math.hypot(o.x() - tx, o.z() - tz) < 1e-4 || Math.abs(o.x() - x) > 7.0 || Math.abs(o.z() - z) > 7.0) continue;
            if (segment(x, z, tx, tz, o.x(), o.z())[1] < o.radius()) return false;
        }
        return true;
    }

    /** The whole hull clear of coastline, shore rocks, dock decks, bridge spans, and BOAT_LIMIT. */
    static boolean boatClear(double x, double z, double yaw) {
        return boatClear(x, z, yaw, HULL);
    }

    static boolean boatClear(double x, double z, double yaw, double[][] hull) {
        if (!Double.isFinite(x) || !Double.isFinite(z) || !Double.isFinite(yaw)) return false;
        if (Math.hypot(x, z) > BOAT_LIMIT) return false;
        double s = Math.sin(yaw), c = Math.cos(yaw);
        for (double[] h : hull) {
            double cx = x + s * h[0], cz = z + c * h[0], r = h[1];
            for (var i : LAYOUT.islands()) {
                double dx = cx - i.x(), dz = cz - i.z();
                double maxCoast = i.radius() * (1.0 + i.lobe3Val() + i.lobe5Val()) + i.shore() + 2.0 + r;
                if (Math.abs(dx) > maxCoast || Math.abs(dz) > maxCoast) continue;
                double d = Math.hypot(dx, dz);
                if (d > maxCoast) continue;
                if (d < shoreRadius(i, Math.atan2(dz, dx)) + r + 0.08) return false;
            }
            for (var k : LAYOUT.rocks()) {
                double dx = cx - k.x(), dz = cz - k.z(), reach = k.r() + r;
                if (Math.abs(dx) < reach && Math.abs(dz) < reach && dx * dx + dz * dz < reach * reach) return false;
            }
            for (var d : LAYOUT.docks()) {
                if (segment(d.ax(), d.az(), d.bx(), d.bz(), cx, cz)[1] < d.width() / 2.0 + r + 0.06) return false;
            }
            for (var b : LAYOUT.bridges()) {
                if (segment(b.ax(), b.az(), b.bx(), b.bz(), cx, cz)[1] < b.width() / 2.0 + r + 0.25) return false;
            }
        }
        return true;
    }

    @FunctionalInterface
    interface HullClearance {
        boolean clear(double x, double z, double yaw);
    }

    static boolean hullsOverlap(double x, double z, double yaw, double bx, double bz, double byaw) {
        return hullsOverlap(x, z, yaw, bx, bz, byaw, HULL, HULL);
    }

    static boolean hullsOverlap(double x, double z, double yaw, double bx, double bz, double byaw, double[][] first, double[][] second) {
        if (Math.abs(x - bx) > 10.5 || Math.abs(z - bz) > 10.5) return false;
        double s = Math.sin(yaw), c = Math.cos(yaw), t = Math.sin(byaw), u = Math.cos(byaw);
        for (double[] a : first) {
            for (double[] b : second) {
                double dx = x + s * a[0] - bx - t * b[0], dz = z + c * a[0] - bz - u * b[0], reach = a[1] + b[1];
                if (dx * dx + dz * dz < reach * reach) return true;
            }
        }
        return false;
    }

    static double[] boatStep(double x, double z, double yaw, double nx, double nz, HullClearance clear) {
        double length = Math.hypot(nx - x, nz - z);
        int n = Math.max(1, (int) Math.ceil(length / 0.12));
        double dx = (nx - x) / n, dz = (nz - z) / n;
        if (!clear.clear(x, z, yaw)) return new double[]{nx, nz};
        for (int j = 0; j < n; j++) {
            boolean moved = false;
            for (double a : SLIDE) {
                double cos = Math.cos(a), sin = Math.sin(a);
                double sx = (dx * cos - dz * sin) * cos, sz = (dx * sin + dz * cos) * cos;
                if (clear.clear(x + sx, z + sz, yaw)) {
                    x += sx;
                    z += sz;
                    moved = true;
                    break;
                }
            }
            if (!moved) break;
        }
        return new double[]{x, z};
    }

    static boolean boatWedged(double x, double z, double yaw, HullClearance clear) {
        double s = Math.sin(yaw) * 0.15, c = Math.cos(yaw) * 0.15;
        return !clear.clear(x + s, z + c, yaw)
                && !clear.clear(x - s, z - c, yaw)
                && !clear.clear(x + c, z - s, yaw)
                && !clear.clear(x - c, z + s, yaw)
                && !clear.clear(x, z, yaw + 0.1)
                && !clear.clear(x, z, yaw - 0.1);
    }

    static double[] boatRescue(double x, double z, double yaw, HullClearance clear) {
        double[] turns = {0, 0.3, -0.3, 0.6, -0.6};
        for (int ring = 1; ring <= 16; ring++) {
            double r = ring * 0.25;
            for (int k = 0; k < 16; k++) {
                double a = k / 16.0 * Math.PI * 2.0, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
                for (double turn : turns) {
                    if (clear.clear(px, pz, yaw + turn)) return new double[]{px, pz, yaw + turn};
                }
            }
        }
        return null;
    }

    static final double BOARD_HULL_GAP = 3.05;
    static final double BOARD_MAX_CENTER_DIST = 8.2;

    static double hullGap(double x, double z, double yaw, double px, double pz) {
        return hullGap(x, z, yaw, px, pz, HULL);
    }

    static double hullGap(double x, double z, double yaw, double px, double pz, double[][] hull) {
        double s = Math.sin(yaw), c = Math.cos(yaw), gap = Double.POSITIVE_INFINITY;
        for (double[] h : hull) gap = Math.min(gap, Math.hypot(px - x - s * h[0], pz - z - c * h[0]) - h[1]);
        return gap;
    }

    static boolean canBoardBoat(double boatX, double boatZ, double boatYaw, double px, double pz, double[][] hull, String model) {
        if (!Double.isFinite(boatX) || !Double.isFinite(boatZ) || !Double.isFinite(boatYaw)) return false;
        if (!Double.isFinite(px) || !Double.isFinite(pz)) return false;
        double centerDist = Math.hypot(px - boatX, pz - boatZ);
        if (centerDist > BOARD_MAX_CENTER_DIST) return false;
        double legacyCenterReach = "cruiser".equals(model) ? 6.2 : 5.4;
        if (hullGap(boatX, boatZ, boatYaw, px, pz, hull) > BOARD_HULL_GAP && centerDist > legacyCenterReach) return false;
        return inReach(px, pz, boatX, boatZ);
    }

    static Landing overboardPoint(double boatX, double boatZ, double boatYaw, double[][] hull) {
        return overboardPoint(boatX, boatZ, boatYaw, hull, "ROWER", 0.0);
    }

    static Landing overboardPoint(double boatX, double boatZ, double boatYaw, double[][] hull, String role, double preferSide) {
        if (!Double.isFinite(boatX) || !Double.isFinite(boatZ) || !Double.isFinite(boatYaw)) return null;
        double minAlong = 0.0, maxAlong = 0.0;
        for (double[] h : hull) {
            if (h[0] < minAlong) minAlong = h[0];
            if (h[0] > maxAlong) maxAlong = h[0];
        }
        double baseStation = "PASSENGER".equals(role) ? 0.9 : -0.25;
        double stationZ = Math.clamp(baseStation, minAlong * 0.72, maxAlong * 0.72);
        double fx = Math.sin(boatYaw), fz = Math.cos(boatYaw);
        double rx = -Math.cos(boatYaw), rz = Math.sin(boatYaw);
        double[] sides = preferSide < -0.05 ? new double[]{-1.0, 1.0} : new double[]{1.0, -1.0};
        double[] angleOffsets = {0.0, -0.28, 0.28, -0.58, 0.58};
        double[] alongShifts = {0.0, -0.6, 0.6};
        double[] clearances = {0.68, 1.05, 1.48};

        for (boolean strictSwim : new boolean[]{true, false}) {
            for (double targetClear : clearances) {
                for (double dAlong : alongShifts) {
                    double along = Math.clamp(stationZ + dAlong, minAlong * 0.85, maxAlong * 0.85);
                    double sx = boatX + fx * along, sz = boatZ + fz * along;
                    for (double side : sides) {
                        for (double aOff : angleOffsets) {
                            double ca = Math.cos(aOff), sa = Math.sin(aOff);
                            double bx = side * rx, bz = side * rz;
                            double ux = bx * ca + fx * sa, uz = bz * ca + fz * sa;
                            Landing hit = traceOverboardRay(boatX, boatZ, boatYaw, hull, sx, sz, ux, uz, targetClear, strictSwim);
                            if (hit != null) return hit;
                        }
                    }
                }
                for (double endSign : new double[]{-1.0, 1.0}) {
                    double along = endSign < 0.0 ? minAlong : maxAlong;
                    double sx = boatX + fx * along, sz = boatZ + fz * along;
                    Landing hit = traceOverboardRay(boatX, boatZ, boatYaw, hull, sx, sz, endSign * fx, endSign * fz, targetClear, strictSwim);
                    if (hit != null) return hit;
                }
            }
        }
        return null;
    }

    private static Landing traceOverboardRay(double boatX, double boatZ, double boatYaw, double[][] hull,
                                             double sx, double sz, double ux, double uz, double targetClear, boolean strictSwim) {
        for (double d = 0.25; d <= 6.4; d += 0.15) {
            double px = sx + ux * d, pz = sz + uz * d;
            double gap = hullGap(boatX, boatZ, boatYaw, px, pz, hull);
            if (gap < targetClear) continue;
            if (Math.hypot(px, pz) > PLAYER_LIMIT - 0.5) return null;
            if (onWood(px, pz) || solidBlocked(px, pz)) return null;
            boolean validWater = strictSwim
                    ? swimmable(px, pz)
                    : walkable(px, pz) && waterDepth(px, pz) >= 0.42;
            if (!validWater) return null;
            return new Landing(px, pz, supportY(px, pz));
        }
        return null;
    }

    static Landing disembarkPoint(double boatX, double boatZ, double boatYaw) {
        return disembarkPoint(boatX, boatZ, boatYaw, HULL);
    }

    static Landing disembarkPoint(double boatX, double boatZ, double boatYaw, double[][] hull) {
        if (!Double.isFinite(boatX) || !Double.isFinite(boatZ) || !Double.isFinite(boatYaw)) return null;
        Landing best = null;
        double bestGap = Double.POSITIVE_INFINITY;
        for (var d : LAYOUT.docks()) {
            double dx = d.bx() - d.ax(), dz = d.bz() - d.az(), len = Math.max(1e-6, Math.hypot(dx, dz));
            if (segment(d.ax(), d.az(), d.bx(), d.bz(), boatX, boatZ)[1] > d.width() / 2.0 + 5.2) continue;
            double nx = -dz / len, nz = dx / len;
            for (int s = 4; s <= 24; s++) {
                double t = s / 24.0;
                double edge = d.width() / 2.0 - 0.32;
                for (double side : new double[]{0.0, -0.6, 0.6, -edge, edge}) {
                    double px = d.ax() + dx * t + nx * side, pz = d.az() + dz * t + nz * side;
                    double gap = hullGap(boatX, boatZ, boatYaw, px, pz, hull);
                    if (gap > 1.6 || gap >= bestGap) continue;
                    double y = floor(px, pz);
                    if (y - GUNWALE_Y > 0.9 || !dryWalkable(px, pz)) continue;
                    bestGap = gap;
                    best = new Landing(px, pz, y);
                }
            }
        }
        if (best != null) return best;

        double maxHullExtent = 2.02;
        for (double[] h : hull) maxHullExtent = Math.max(maxHullExtent, Math.abs(h[0]) + h[1]);

        Landing bestDry = null;
        double bestDryGap = Double.POSITIVE_INFINITY;
        Landing bestWade = null;
        double bestWadeGap = Double.POSITIVE_INFINITY;
        double[] dryRadialOffsets = {-0.15, -0.45, -0.8, -1.15, -1.5, -1.85, -2.2, -2.55};
        double[] wadeRadialOffsets = {0.35, 0.05, -0.25};

        for (var isl : LAYOUT.islands()) {
            double dxB = boatX - isl.x(), dzB = boatZ - isl.z(), distB = Math.hypot(dxB, dzB);
            if (distB > isl.radius() * 1.25 + isl.shore() + maxHullExtent + 4.0) continue;
            double boatBearing = Math.atan2(dzB, dxB);
            double shoreAtBoat = shoreRadius(isl, boatBearing);
            if (distB - shoreAtBoat > maxHullExtent + 2.85) continue;

            boolean isIslet = "islet".equals(isl.profileVal());
            double maxStepUp = isIslet ? 1.75 : 1.18;
            double maxDryGap = isIslet ? 2.95 : 2.25;
            for (int k = -7; k <= 7; k++) {
                double a = boatBearing + k * 0.055;
                double sr = shoreRadius(isl, a);
                double ux = Math.cos(a), uz = Math.sin(a);
                double wx = isl.x() + ux * (sr + 0.35), wz = isl.z() + uz * (sr + 0.35);
                double inR = Math.max(1.5, sr - 2.6);
                double inX = isl.x() + ux * inR, inZ = isl.z() + uz * inR;
                for (double rOff : dryRadialOffsets) {
                    double px = isl.x() + ux * (sr + rOff), pz = isl.z() + uz * (sr + rOff);
                    double gap = hullGap(boatX, boatZ, boatYaw, px, pz, hull);
                    if (gap < -0.05 || gap > maxDryGap || gap >= bestDryGap) continue;
                    if (!dryWalkable(px, pz)) continue;
                    double y = floor(px, pz);
                    if (y - GUNWALE_Y > maxStepUp) continue;
                    if (isIslet) {
                        if (!dryWalkable(inX, inZ)) continue;
                        double[] stIn = step(px, pz, inX, inZ);
                        if (Math.hypot(stIn[0] - inX, stIn[1] - inZ) > 0.22 || !inReach(boatX, boatZ, px, pz)) continue;
                    } else {
                        double[] st = step(wx, wz, px, pz);
                        if (Math.hypot(st[0] - px, st[1] - pz) > 0.22 || !inReach(wx, wz, px, pz)) continue;
                    }
                    bestDryGap = gap;
                    bestDry = new Landing(px, pz, y);
                }
            }

            if (bestDry == null) {
                for (int k = -6; k <= 6; k++) {
                    double a = boatBearing + k * 0.06;
                    double sr = shoreRadius(isl, a);
                    double ux = Math.cos(a), uz = Math.sin(a);
                    double inR = Math.max(2.0, sr - 2.4);
                    double ix = isl.x() + ux * inR, iz = isl.z() + uz * inR;
                    if (!dryWalkable(ix, iz)) continue;
                    for (double rOff : wadeRadialOffsets) {
                        double px = isl.x() + ux * (sr + rOff), pz = isl.z() + uz * (sr + rOff);
                        double gap = hullGap(boatX, boatZ, boatYaw, px, pz, hull);
                        if (gap < 0.25 || gap > 1.85 || gap >= bestWadeGap) continue;
                        if (onWood(px, pz) || waterDepth(px, pz) > 0.62 || !walkable(px, pz)) continue;
                        double[] st = step(px, pz, ix, iz);
                        if (Math.hypot(st[0] - ix, st[1] - iz) > 0.25 || !inReach(px, pz, ix, iz)) continue;
                        bestWadeGap = gap;
                        bestWade = new Landing(px, pz, supportY(px, pz));
                    }
                }
            }
        }

        return bestDry != null ? bestDry : bestWade;
    }
}
