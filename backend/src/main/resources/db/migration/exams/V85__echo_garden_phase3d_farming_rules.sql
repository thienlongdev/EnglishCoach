-- Echo Garden Phase 3D (farming economy 2.0) - RULES. Numbers: docs/echo-garden/PHASE3D_ECONOMY_SIM_RESULTS.md.
-- Requires the V84 schema. Additive data only: no balance, inventory, planting, ledger or history row is touched.
-- "Dong Echo / Echo Coin" is the display name of the existing garden coin balance: there is no second currency and
-- no conversion, so no profile or ledger value is rewritten here.
-- Applied only by normal application startup (never manually).

-- ===== crop growth profiles =====
-- Every species keeps its code, rarity, season and unlock level. Growth times are spread from a 30-minute crop to a
-- 36-hour one; longer crops are worth more per harvest and less per hour, so a slow crop rewards planning and a fast
-- crop rewards a short visit. Sale prices never go down, so produce already in a storehouse keeps (at least) its value.
-- Each UPDATE is guarded by the V77 value: it runs once and never overwrites a later calibration.
-- A planting stores its own base_seconds at planting time: crops already in the ground keep the time they were
-- planted with (and growth model 1, see V84).
UPDATE public.garden_crop_def SET base_seconds =   1800, seed_price =   5, sell_price =   16, harvest_xp =   4 WHERE code = 'WHEAT'          AND base_seconds =  1200;
UPDATE public.garden_crop_def SET base_seconds =   5400, seed_price =  16, sell_price =   44, harvest_xp =   8 WHERE code = 'TOMATO'         AND base_seconds =  2700;
UPDATE public.garden_crop_def SET base_seconds =  10800, seed_price =  28, sell_price =   84, harvest_xp =  12 WHERE code = 'CORN'           AND base_seconds =  5400;
UPDATE public.garden_crop_def SET base_seconds =  18000, seed_price =  45, sell_price =  130, harvest_xp =  20 WHERE code = 'STRAWBERRY'     AND base_seconds =  7200;
UPDATE public.garden_crop_def SET base_seconds =  28800, seed_price =  80, sell_price =  215, harvest_xp =  32 WHERE code = 'ROSE'           AND base_seconds = 14400;
UPDATE public.garden_crop_def SET base_seconds =  43200, seed_price = 100, sell_price =  300, harvest_xp =  42 WHERE code = 'WATERMELON'     AND base_seconds = 18000;
UPDATE public.garden_crop_def SET base_seconds =  57600, seed_price = 125, sell_price =  385, harvest_xp =  52 WHERE code = 'PUMPKIN'        AND base_seconds = 21600;
UPDATE public.garden_crop_def SET base_seconds =  72000, seed_price = 200, sell_price =  560, harvest_xp =  70 WHERE code = 'MOONFLOWER'     AND base_seconds = 28800;
UPDATE public.garden_crop_def SET base_seconds =  86400, seed_price = 250, sell_price =  700, harvest_xp =  85 WHERE code = 'FROST_LILY'     AND base_seconds = 36000;
UPDATE public.garden_crop_def SET base_seconds = 129600,                   sell_price = 1500, harvest_xp = 180 WHERE code = 'CRYSTAL_ORCHID' AND base_seconds = 64800;

-- ===== farming supplies sold at the Echo market (kind TOOL; fertilizers stay kind BOOST) =====
-- Fixed coin price, purchases per Vietnam day, farm level. What each one does is in `farming.items` below.
INSERT INTO public.garden_item_def (code, kind, name_vi, params, coin_price, essence_price, daily_cap, unlock_level, in_fixed_shop)
VALUES
    ('WELL_WATER',    'TOOL', 'Nước Giếng',           '{}',  20, 0, 6, 2, TRUE),
    ('MULCH',         'TOOL', 'Rơm Phủ Gốc',          '{}',  45, 0, 4, 3, TRUE),
    ('RAIN_COVER',    'TOOL', 'Bạt Che Mưa',          '{}',  60, 0, 3, 4, TRUE),
    ('SHADE_NET',     'TOOL', 'Lưới Che Nắng',        '{}',  60, 0, 3, 4, TRUE),
    ('DRAINAGE',      'TOOL', 'Rãnh Thoát Nước',      '{}',  90, 0, 2, 6, TRUE),
    ('ORGANIC_SPRAY', 'TOOL', 'Thuốc Xịt Hữu Cơ',     '{}',  70, 0, 2, 3, TRUE),
    ('INSECT_NET',    'TOOL', 'Lưới Chắn Côn Trùng',  '{}', 110, 0, 2, 5, TRUE),
    ('CROP_TONIC',    'TOOL', 'Thuốc Dưỡng Cây',      '{}', 120, 0, 2, 6, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ===== Phase 3D configuration =====
INSERT INTO public.garden_config (key, value) VALUES
    -- soil: moisture 0..100 of a growing crop (growth model 2), a pure function of server facts: the planting instant,
    --   the global weather timeline, the crop's thirst, the season, waterings and supplies. Nothing runs in the background.
    --   start         moisture of freshly sown soil
    --   dryBelow      below this the crop is thirsty (growth x dryFactor); wetAbove: above this it is waterlogged (x wetFactor)
    --   evapPerHour   moisture lost per hour without rain (x crop thirst x seasonEvap; x rainbowEvap under a rainbow)
    --   rainPerHour   moisture gained per hour of rain
    --   waterGain     moisture one watering (the Flashcard-review resource WATER) adds, on top of its growth boost
    --   maxStressHours  the slowdown of dry + waterlogged soil is counted for at most this many hours per planting:
    --                   the whole growth loss of one crop is bounded (it always ripens, never unripens, never dies)
    --   careShare     harvest "care" points are multiplied by the factor of the first row whose share of the growing
    --                 time spent stressed is not exceeded; beyond the last row the factor is 0
    --   severeShare   a crop stressed for more than this share of its growing time is harvested at severeTierCap at
    --                 best (it still ripens and is still worth selling); later good care dilutes the share again
    -- thirst: evaporation multiplier per crop (thirsty crops dry out sooner, hardy crops stay wet longer).
    -- items: what each supply does when applied to one growing crop.
    --   MOISTURE    +value moisture now (no growth boost: the boost stays a Flashcard-review reward)
    --   MULCH       evaporation and rain absorption x value until harvest
    --   RAIN_COVER  for `hours`: rain adds no moisture (and gives no rain growth bonus)
    --   SHADE       for `hours`: evaporation x value
    --   DRAINAGE    moisture drops to `value` now and cannot pass the waterlogging line for `hours`
    --   TONIC       for `hours`: stressed soil does not slow the crop; the stressed share used for the care points is
    --               multiplied by value (once per planting)
    --   PEST_SPRAY  for `hours`: a Forgotten Pest on the crop does not slow it and a harvest counts at least `value`
    --               pest points. It never reviews a card: only a genuine Flashcard review resolves the pest.
    --   PEST_NET    for `hours`: no NEW Forgotten Pest can settle on this crop
    --   BOOST       the existing fertilizers (applied through the boost command); listed for the shop category only
    -- harvestBonus: coins granted once per closed harvest = max(min, round(sell price x share)), at most dailyCap coins
    --   per Vietnam day; a crop with sell price 0 (QA) pays nothing.
    ('farming', '{
       "soil":{"start":60,"dryBelow":25,"wetAbove":85,"evapPerHour":4.5,"rainPerHour":6,"rainbowEvap":0.5,
               "dryFactor":0.6,"wetFactor":0.6,"maxStressHours":10,"waterGain":35,
               "seasonEvap":{"LU_HANH":1.0,"CONG_SO":1.25,"HOC_THUAT":1.0,"THANH_NGU":0.75},
               "careShare":[[0.15,1.0],[0.4,0.5]],"severeShare":0.4,"severeTierCap":"GOOD"},
       "thirst":{"WHEAT":0.7,"TOMATO":1.3,"CORN":0.8,"STRAWBERRY":1.2,"ROSE":1.0,"WATERMELON":1.5,"PUMPKIN":1.1,
                 "MOONFLOWER":0.9,"FROST_LILY":0.8,"CRYSTAL_ORCHID":1.0,"QA_SPROUT":1.0},
       "items":{
         "FERTILIZER":{"category":"CARE","effect":"BOOST","hours":0,"value":0},
         "FERTILIZER_PREMIUM":{"category":"CARE","effect":"BOOST","hours":0,"value":0},
         "MULCH":{"category":"CARE","effect":"MULCH","hours":0,"value":0.6},
         "CROP_TONIC":{"category":"CARE","effect":"TONIC","hours":8,"value":0.5},
         "RAIN_COVER":{"category":"WEATHER","effect":"RAIN_COVER","hours":12,"value":0},
         "SHADE_NET":{"category":"WEATHER","effect":"SHADE","hours":12,"value":0.4},
         "DRAINAGE":{"category":"WEATHER","effect":"DRAINAGE","hours":24,"value":65},
         "ORGANIC_SPRAY":{"category":"PEST","effect":"PEST_SPRAY","hours":12,"value":18},
         "INSECT_NET":{"category":"PEST","effect":"PEST_NET","hours":24,"value":0},
         "WELL_WATER":{"category":"UTILITY","effect":"MOISTURE","hours":0,"value":30}},
       "harvestBonus":{"share":0.06,"min":1,"dailyCap":400}}')
ON CONFLICT (key) DO NOTHING;
