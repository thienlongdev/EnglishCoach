package com.englishcoach.speaking.arena;

import org.junit.jupiter.api.Test;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class ArenaGeometryTest {

    @Test
    void layoutV7ByteParityAndCompleteEntityCensus() throws Exception {
        assertEquals(7, ArenaGeometry.LAYOUT.version());
        assertEquals(15, ArenaGeometry.LAYOUT.islands().size());
        assertEquals(2, ArenaGeometry.LAYOUT.bridges().size());
        assertEquals(11, ArenaGeometry.LAYOUT.docks().size());
        assertEquals(14, ArenaGeometry.LAYOUT.boats().size());
        assertEquals(15, ArenaGeometry.LAYOUT.interactables().stream().filter(i -> "kiosk".equals(i.kind())).count());
        assertTrue(ArenaGeometry.LAYOUT.interactables().stream().anyMatch(i -> "fruit_tree".equals(i.kind())));
        assertTrue(ArenaGeometry.LAYOUT.interactables().stream().anyMatch(i -> "fishing_spot".equals(i.kind())));

        Path feLayout = Path.of("..", "frontend", "src", "components", "features", "speaking", "arena", "arenaLayout.json");
        if (Files.exists(feLayout)) {
            byte[] feBytes = Files.readAllBytes(feLayout);
            try (var in = ArenaGeometry.class.getResourceAsStream("/data/speaking-arena-layout.json")) {
                assertNotNull(in);
                assertArrayEquals(feBytes, in.readAllBytes(), "FE arenaLayout.json and BE speaking-arena-layout.json must stay byte-identical");
            }
        }
    }

    @Test
    void allIslandsBridgesDocksAndMountainSummitAreReachableOnDryLand() {
        assertEquals(0.0, ArenaGeometry.height(0, 0), 1e-6);
        assertEquals(0.0, ArenaGeometry.height(-2, 2), 1e-6);
        assertEquals(0.0, ArenaGeometry.height(2, 2), 1e-6);
        assertTrue(ArenaGeometry.dryWalkable(0, 0));

        for (var i : ArenaGeometry.LAYOUT.islands()) {
            if ("atoll".equals(i.profileVal())) {
                // Coral Lagoon center is a turquoise snorkeling lagoon; its surrounding coral-sand ring is dry walkable.
                assertTrue(ArenaGeometry.bathymetry(i.x(), i.z() + 2) <= -4.5, "Atoll central lagoon depth");
                assertTrue(ArenaGeometry.swimmable(i.x(), i.z() + 2), "Atoll central lagoon is swimmable");
                assertTrue(ArenaGeometry.dryWalkable(i.x(), i.z() - 56), "Atoll north cay ring is dry walkable");
            } else if ("lighthouse".equals(i.id())) {
                assertTrue(ArenaGeometry.dryWalkable(i.x() + 10, i.z()));
            } else {
                assertTrue(ArenaGeometry.dryWalkable(i.x(), i.z()), "Island center dryWalkable: " + i.id());
            }
        }

        // Mountain summit reaches +16.5 m and is smoothly walkable all the way up
        assertTrue(ArenaGeometry.height(-16, -225) >= 16.4, "Mountain summit reaches +16.5 m");
        double mx = -6, mz = -150;
        for (int s = 0; s < 140; s++) {
            double dx = -16 - mx, dz = -225 - mz, dist = Math.hypot(dx, dz);
            if (dist < 0.2) break;
            double stepLen = Math.min(dist, 0.85);
            double[] next = ArenaGeometry.step(mx, mz, mx + dx / dist * stepLen, mz + dz / dist * stepLen);
            mx = next[0];
            mz = next[1];
        }
        assertTrue(Math.hypot(mx - (-16), mz - (-225)) < 1.0, "Player walks smoothly all the way to the +16.5 m summit");

        for (var b : ArenaGeometry.LAYOUT.bridges()) {
            double prev = ArenaGeometry.height(b.ax(), b.az());
            for (int j = 0; j <= 100; j++) {
                double t = j / 100.0;
                double x = b.ax() + (b.bx() - b.ax()) * t, z = b.az() + (b.bz() - b.az()) * t;
                assertTrue(ArenaGeometry.dryWalkable(x, z));
                double h = ArenaGeometry.height(x, z);
                assertTrue(Math.abs(h - prev) < 0.04);
                prev = h;
            }
        }
    }

    @Test
    void cliffsPreventWalkOffUnlessJumpingWhileBeachesAndDockLaddersAllowSwimming() {
        // 1. Harbor stone quay / cliff (bearing 0.85 rad, non-beach) blocks accidental walk-off without jumping
        double cliffAngle = 0.85;
        var commons = ArenaGeometry.LAYOUT.islands().getFirst();
        double shoreR = ArenaGeometry.shoreRadius(commons, cliffAngle);
        double startR = shoreR - commons.shore() - 2.5;
        double endR = shoreR + 6.0;
        double sx = Math.cos(cliffAngle) * startR, sz = Math.sin(cliffAngle) * startR;
        double ex = Math.cos(cliffAngle) * endR, ez = Math.sin(cliffAngle) * endR;
        assertTrue(ArenaGeometry.dryWalkable(sx, sz));
        double[] blockedAtCliff = ArenaGeometry.step(sx, sz, ex, ez);
        double stoppedShore = ArenaGeometry.shoreRadius(commons, Math.atan2(blockedAtCliff[1], blockedAtCliff[0]));
        assertTrue(Math.hypot(blockedAtCliff[0], blockedAtCliff[1]) < stoppedShore, "Grounded walker stops at cliff rim");
        assertFalse(ArenaGeometry.isSwimming(blockedAtCliff[0], blockedAtCliff[1]), "Grounded walker does not fall into sea");

        // Jumping (elevated feet) leaps cleanly over the cliff edge into swimmable water
        double jumpFeet = ArenaGeometry.supportY(sx, sz) + 0.75;
        double[] jumpedOff = ArenaGeometry.step(sx, sz, ex, ez, jumpFeet);
        assertTrue(ArenaGeometry.isSwimming(jumpedOff[0], jumpedOff[1]), "Jumping over cliff lands in swimmable water");
        assertEquals(ArenaGeometry.SWIM_SUPPORT_Y, ArenaGeometry.supportY(jumpedOff[0], jumpedOff[1]), 1e-6);

        // Swimmer at base of cliff cannot walk straight up the steep rock wall
        double[] blockedUpCliff = ArenaGeometry.step(ex, ez, sx, sz);
        assertTrue(Math.hypot(blockedUpCliff[0], blockedUpCliff[1]) > shoreR - 0.5, "Swimmer cannot climb vertical cliff");

        // 2. Southwest sandy beach on commons (bearing 2.30 rad) allows seamless walk -> swim -> walk back
        double beachAngle = 2.30;
        double beachShore = ArenaGeometry.shoreRadius(commons, beachAngle);
        double bx = Math.cos(beachAngle) * (beachShore - 14.0), bz = Math.sin(beachAngle) * (beachShore - 14.0);
        double wx = Math.cos(beachAngle) * (beachShore + 12.0), wz = Math.sin(beachAngle) * (beachShore + 12.0);
        double[] intoSea = ArenaGeometry.step(bx, bz, wx, wz);
        assertTrue(Math.hypot(intoSea[0] - wx, intoSea[1] - wz) < 0.25, "Continuous walk from sandy beach into sea");
        assertTrue(ArenaGeometry.isSwimming(intoSea[0], intoSea[1]));

        double[] backAshore = ArenaGeometry.step(intoSea[0], intoSea[1], bx, bz);
        assertTrue(Math.hypot(backAshore[0] - bx, backAshore[1] - bz) < 0.25, "Continuous swim/wade back onto dry sandy beach");
        assertTrue(ArenaGeometry.dryWalkable(backAshore[0], backAshore[1]));

        // 3. Open ocean bathymetry is negative (< WATER_Y) and bounded by PLAYER_LIMIT (540 m)
        assertTrue(ArenaGeometry.height(-105, 18) < ArenaGeometry.WATER_Y - 10.0);
        assertFalse(ArenaGeometry.walkable(545, 0));
        assertFalse(ArenaGeometry.swimmable(0, -545));
    }

    @Test
    void decorativeSolidsPlantersAndKarstSpiresAreColliders() {
        for (var o : ArenaGeometry.LAYOUT.obstacles()) {
            if ("shrub".equals(o.kind()) || "sign".equals(o.kind()) || "lantern".equals(o.kind())
                    || "planter".equals(o.kind()) || "karst_spire".equals(o.kind()) || "tower".equals(o.kind())) {
                assertFalse(ArenaGeometry.walkable(o.x(), o.z()), o.kind() + " at " + o.x() + "," + o.z());
            }
        }
        double[] planter = ArenaGeometry.step(-13, -11, -7, -11);
        assertTrue(planter[0] < -12);
        double[] shrub = ArenaGeometry.step(19.5, -12.5, 19.5, -18.5);
        assertTrue(shrub[1] > -15.5 + 0.82, "walked into the shrub at (19.5,-15.5)");
        assertFalse(ArenaGeometry.inReach(-13, -11, -7, -11));
    }

    @Test
    void hullsCollideCircleByCircleAndStopAtOrganicCoastline() {
        assertTrue(ArenaGeometry.hullsOverlap(0, 0, 0, 0, 3.3, Math.PI));
        assertFalse(ArenaGeometry.hullsOverlap(0, 0, 0, 2.2, 0, 0));
        var step = ArenaGeometry.boatStep(-110, 20, Math.PI / 2, -100, 20,
                (x, z, yaw) -> !ArenaGeometry.hullsOverlap(x, z, yaw, -103, 20, 0));
        assertTrue(step[0] < -105);

        // Rowing straight at commons rocky shore (bearing 2.95 rad, clear of piers): bow stops off the coastline
        var commons = ArenaGeometry.LAYOUT.islands().getFirst();
        double a = 2.95;
        double coast = ArenaGeometry.shoreRadius(commons, a);
        double sx = Math.cos(a) * (coast + 18.0), sz = Math.sin(a) * (coast + 18.0);
        double yaw = Math.atan2(-Math.cos(a), -Math.sin(a));
        assertTrue(ArenaGeometry.boatClear(sx, sz, yaw));
        double[] at = ArenaGeometry.boatStep(sx, sz, yaw, 0, 0, ArenaGeometry::boatClear);
        assertTrue(ArenaGeometry.boatClear(at[0], at[1], yaw));
        assertTrue(Math.hypot(at[0], at[1]) < coast + 8.0, "hull approached the coast");
        double bx = at[0] + Math.sin(yaw) * 1.52, bz = at[1] + Math.cos(yaw) * 1.52;
        assertTrue(Math.hypot(bx, bz) >= ArenaGeometry.shoreRadius(commons, Math.atan2(bz, bx)) + 0.5, "bow circle stays off the rock");

        for (var k : ArenaGeometry.LAYOUT.rocks()) {
            assertFalse(ArenaGeometry.boatClear(k.x(), k.z(), yaw), "rock " + k.x() + "," + k.z() + " is solid to a hull");
        }
        for (var b : ArenaGeometry.LAYOUT.bridges()) {
            double mx = (b.ax() + b.bx()) / 2, mz = (b.az() + b.bz()) / 2;
            double bYaw = Math.atan2(b.bz() - b.az(), -(b.bx() - b.ax()));
            assertFalse(ArenaGeometry.boatClear(mx, mz, bYaw), "under the bridge at " + mx + "," + mz);
        }
        for (var d : ArenaGeometry.LAYOUT.docks()) {
            double x = d.ax() + (d.bx() - d.ax()) * 0.85, z = d.az() + (d.bz() - d.az()) * 0.85;
            assertFalse(ArenaGeometry.boatClear(x, z, 0), "on the pier " + d.id());
        }
    }

    @Test
    void wedgedHullsAndAllFourteenVesselsAcrossElevenPiersAreSafe() {
        var firstBoat = ArenaGeometry.LAYOUT.boats().getFirst();
        var firstHull = ArenaGeometry.hullForModel(firstBoat.model());
        assertFalse(ArenaGeometry.boatWedged(firstBoat.x(), firstBoat.z(), firstBoat.yaw(),
                (x, z, y) -> ArenaGeometry.boatClear(x, z, y, firstHull)), "moored boat can move");
        double[] free = ArenaGeometry.boatRescue(firstBoat.x(), firstBoat.z(), firstBoat.yaw(),
                (x, z, y) -> ArenaGeometry.boatClear(x, z, y, firstHull));
        assertNotNull(free);
        assertTrue(Math.hypot(free[0] - firstBoat.x(), free[1] - firstBoat.z()) <= 4.01);
        assertTrue(ArenaGeometry.boatWedged(0, 0, 0, (x, z, y) -> false));
        assertNull(ArenaGeometry.boatRescue(0, 0, 0, (x, z, y) -> false));

        for (var d : ArenaGeometry.LAYOUT.docks()) {
            double prev = ArenaGeometry.height(d.ax(), d.az());
            for (int j = 0; j <= 100; j++) {
                double t = j / 100.0;
                double x = d.ax() + (d.bx() - d.ax()) * t, z = d.az() + (d.bz() - d.az()) * t;
                assertTrue(ArenaGeometry.dryWalkable(x, z), "dock " + d.id() + " walkable at t=" + t);
                double h = ArenaGeometry.height(x, z);
                assertTrue(Math.abs(h - prev) < 0.07, "dock " + d.id() + " smooth ramp");
                prev = h;
            }
            double dx = d.bx() - d.ax(), dz = d.bz() - d.az(), len = Math.hypot(dx, dz);
            double swimX = d.bx() + dx / len * (d.width() / 2.0 + 1.1);
            double swimZ = d.bz() + dz / len * (d.width() / 2.0 + 1.1);
            var climb = ArenaGeometry.climbOutPoint(swimX, swimZ);
            assertNotNull(climb, "Swimmer climb-out point off " + d.id());
            assertTrue(ArenaGeometry.dryWalkable(climb.x(), climb.z()));
        }

        for (var b : ArenaGeometry.LAYOUT.boats()) {
            var hull = ArenaGeometry.hullForModel(b.model());
            assertTrue(ArenaGeometry.boatClear(b.x(), b.z(), b.yaw(), hull), "moored boat " + b.id() + " sits in clear water");
            var land = ArenaGeometry.disembarkPoint(b.x(), b.z(), b.yaw(), hull);
            assertNotNull(land, "moored boat " + b.id() + " has a pier landing");
            assertTrue(ArenaGeometry.dryWalkable(land.x(), land.z()));
            assertTrue(ArenaGeometry.hullGap(b.x(), b.z(), b.yaw(), land.x(), land.z(), hull) <= 1.6);
        }

        assertFalse(ArenaGeometry.boatClear(0, 0, 0), "boats cannot enter island plaza");
        assertNull(ArenaGeometry.disembarkPoint(-105, 18, 0), "open ocean refuses unsafe disembark");
        assertNull(ArenaGeometry.climbOutPoint(-105, 18), "open ocean has no dock ladder");
    }

    @Test
    void overboardJumpAndAllFifteenIslandsSupportBeachOrCoveDisembarkAndReboarding() {
        // 1. Overboard jump works anywhere in open water across all hull classes with hullGap >= 0.55 m
        for (String model : List.of("skiff", "sampan", "pelagic", "tern", "cruiser")) {
            double[][] hull = ArenaGeometry.hullForModel(model);
            for (String role : List.of("ROWER", "PASSENGER")) {
                var water = ArenaGeometry.overboardPoint(-105.0, 18.0, 0.7, hull, role, 1.0);
                assertNotNull(water, "overboard jump available in open ocean for " + model + " " + role);
                assertTrue(ArenaGeometry.hullGap(-105.0, 18.0, 0.7, water.x(), water.z(), hull) >= 0.55,
                        "overboard landing clears hull >= 0.55 m");
                assertTrue(ArenaGeometry.swimmable(water.x(), water.z()));
                assertEquals(ArenaGeometry.SWIM_SUPPORT_Y, water.y(), 1e-6);
            }
        }

        // 2. Steep karst cliff without pier still strictly refuses disembarkation
        var karst = ArenaGeometry.LAYOUT.islands().stream().filter(i -> "karst_bay".equals(i.id())).findFirst().orElseThrow();
        double kr = ArenaGeometry.shoreRadius(karst, -2.1) + 3.2;
        assertNull(ArenaGeometry.disembarkPoint(karst.x() + Math.cos(-2.1) * kr, karst.z() + Math.sin(-2.1) * kr, 0.0),
                "steep karst cliff refuses disembark");

        // 3. Every one of the 15 islands (including all 7 dockless islets!) has at least one accessible shore landing & re-board point
        for (var isl : ArenaGeometry.LAYOUT.islands()) {
            boolean landedOnIsland = false;
            for (int s = 0; s < 72 && !landedOnIsland; s++) {
                double a = (s / 72.0) * Math.PI * 2.0 - Math.PI;
                double sr = ArenaGeometry.shoreRadius(isl, a);
                double ux = Math.cos(a), uz = Math.sin(a);
                double bowInYaw = Math.atan2(-ux, -uz);
                for (double seaD = 1.25; seaD <= 5.5; seaD += 0.25) {
                    double bx = isl.x() + ux * (sr + seaD), bz = isl.z() + uz * (sr + seaD);
                    if (!ArenaGeometry.boatClear(bx, bz, bowInYaw, ArenaGeometry.HULL)) continue;
                    var land = ArenaGeometry.disembarkPoint(bx, bz, bowInYaw, ArenaGeometry.HULL);
                    if (land != null) {
                        assertTrue(ArenaGeometry.walkable(land.x(), land.z()), "landing walkable on " + isl.id());
                        assertTrue(ArenaGeometry.canBoardBoat(bx, bz, bowInYaw, land.x(), land.z(), ArenaGeometry.HULL, "skiff"),
                                "can re-board boat from landing on " + isl.id());
                        landedOnIsland = true;
                    }
                    break;
                }
            }
            assertTrue(landedOnIsland, "Island must have accessible boat landing (pier, beach, or gentle cove): " + isl.id());
        }

        // 4. Explicit west-channel skiff approach onto dockless islet_coral_east (123.6, 232.0, yaw=1.57)
        var coralEastLand = ArenaGeometry.disembarkPoint(123.6, 232.0, 1.57, ArenaGeometry.HULL);
        assertNotNull(coralEastLand, "skiff at (123.6, 232.0, yaw=1.57) disembarks onto islet_coral_east");
        assertEquals("islet_coral_east", ArenaGeometry.islandAt(coralEastLand.x(), coralEastLand.z()));
        assertTrue(ArenaGeometry.dryWalkable(coralEastLand.x(), coralEastLand.z()));
        assertTrue(ArenaGeometry.canBoardBoat(123.6, 232.0, 1.57, coralEastLand.x(), coralEastLand.z(), ArenaGeometry.HULL, "skiff"),
                "player on islet_coral_east can immediately re-board skiff at (123.6, 232.0)");

        // 5. Cruiser bow/stern swimmer boarding works across 8.5 m hull via hullGap
        double cx = -105.0, cz = 18.0, cyaw = 0.0;
        double bowSwimZ = cz + 3.65 + 0.72 + 1.8; // 6.17 m from center, 1.80 m off bow circle
        assertTrue(ArenaGeometry.canBoardBoat(cx, cz, cyaw, cx, bowSwimZ, ArenaGeometry.CRUISER_HULL, "cruiser"),
                "Swimmer 1.8 m off cruiser bow can climb aboard");
    }
}
