package com.englishcoach.kingofenglish;

import java.util.Map;
import java.util.List;
/** Canonical config, emitted to clients; no duplicated gameplay constants. */
public final class KingConfig {
    private KingConfig() {}
    public static final int ROOM_CAP=500, RECEIPT_CAP=256, REORDER_ROUNDS=10, SUDDEN_MAX=3, REFLEX_SLOTS=13;
    public static final long WAIT_TTL=300_000, FINISH_TTL=120_000, FINISH_KEEP_TTL=1_800_000, DISCONNECT_GRACE=30_000,
        REORDER_MS=30_000, WRONG_LOCK_MS=1_500, REFLEX_MS=90_000, RESOLUTION_MS=2_500;
    public static final int EXPLAIN_ROUNDS=6, EXPLAIN_CLUE_MAX=400, EXPLAIN_CLUE_CAP=8, EXPLAIN_GUESS_CAP=12;
    public static final long EXPLAIN_MS=60_000, EXPLAIN_CLUE_INTERVAL=20_000;
    public static int explainGuesserScore(long elapsed){return elapsed<=15_000?4:elapsed<=30_000?3:elapsed<=45_000?2:1;}
    public static int explainDescriberScore(long elapsed){return elapsed<=30_000?2:1;}
    public static int explainAuthoredScore(int clue){return 3-clue;}
    public static final int CONQUEST_WORD_CAP=180, CONQUEST_TERRITORY_POINT=2, CONQUEST_THRONE_BONUS=5;
    public static final long CONQUEST_MS=180_000;
    /** Soán ngôi board sizes and their clocks (owner 2026-10-29): 4×4 2 min, 5×5 3 min (unchanged), 6×6 4.5 min, 7×7 6 min. */
    public static final Map<Integer,Long> CONQUEST_SIZES=Map.of(4,120_000L,5,CONQUEST_MS,6,270_000L,7,360_000L);
    public static final int CONQUEST_DEFAULT_SIZE=5;
    /** Sizes without an offline bank: their boards are solved at run time. */
    public static final java.util.List<Integer> CONQUEST_GENERATED_SIZES=java.util.List.of(4,6,7);
    public static long conquestMs(int size){Long ms=CONQUEST_SIZES.get(size);if(ms==null)throw new KingService.Rejection("INVALID_BOARD_SIZE");return ms;}
    public static int conquestWordPoints(int length){return Math.min(4,Math.max(1,length-2));}
    public static Map<String,Object> publicConfig() {
        var config=new java.util.LinkedHashMap<String,Object>(Map.of("roomCap",ROOM_CAP,"receiptCap",RECEIPT_CAP,"reorderRounds",REORDER_ROUNDS,
            "suddenMax",SUDDEN_MAX,"reorderMs",REORDER_MS,"wrongLockMs",WRONG_LOCK_MS,
            "reflexMs",REFLEX_MS,"reflexSlots",REFLEX_SLOTS));
        config.put("resolutionMs",RESOLUTION_MS);config.put("explainMs",EXPLAIN_MS);config.put("explainRounds",EXPLAIN_ROUNDS);config.put("explainClueMax",EXPLAIN_CLUE_MAX);config.put("explainGuessCap",EXPLAIN_GUESS_CAP);config.put("explainClueInterval",EXPLAIN_CLUE_INTERVAL);
        config.put("championshipModes",List.of("REFLEX","EXPLAIN","REORDER","CONQUEST"));config.put("championshipRoundMs",15_000);
        config.put("explainGuesserScores",List.of(4,3,2,1));config.put("explainDescriberScores",List.of(2,1));config.put("explainAuthoredScores",List.of(3,2,1));config.put("conquestMs",CONQUEST_MS);config.put("conquestWordCap",CONQUEST_WORD_CAP);config.put("conquestTerritoryPoint",CONQUEST_TERRITORY_POINT);config.put("conquestThroneBonus",CONQUEST_THRONE_BONUS);config.put("conquestWordPointCap",4);
        config.put("conquestSizes",CONQUEST_SIZES.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(e->Map.of("size",e.getKey(),"ms",e.getValue())).toList());return config;
    }
}

