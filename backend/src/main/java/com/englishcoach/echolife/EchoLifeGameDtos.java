package com.englishcoach.echolife;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Wire shapes of the Echo Life game (V130): the narrative save, the authoritative wallet, reward claims and purchases. */
public final class EchoLifeGameDtos {

    private EchoLifeGameDtos() {
    }

    /** One bought thing the learner still owns (server-made instance id). */
    public record Owned(String instanceId, String storeId, String sku, String itemType, int price) {
    }

    /**
     * The learner's economy as the server keeps it. {@code skills} maps each V3 skill to its XP; {@code claimed} is every unique
     * reward already granted; {@code dailyCredits}/{@code dailyXp} are today's (Asia/Ho_Chi_Minh) repeatable earnings.
     */
    public record Wallet(int credits, Map<String, Integer> skills, int level, List<String> claimed, List<Owned> owned,
                         int dailyCredits, int dailyXp, JsonNode workshop, long workshopRevision) {
        public Wallet(int credits, Map<String,Integer> skills, int level, List<String> claimed, List<Owned> owned, int dailyCredits, int dailyXp) {
            this(credits,skills,level,claimed,owned,dailyCredits,dailyXp,null,0);
        }
    }

    /** {@code revision} 0 = no game yet ({@code doc} null). The wallet always comes with it. */
    public record Game(int saveVersion, long revision, JsonNode doc, Wallet wallet, Instant updatedAt) {
    }

    public record SaveGameRequest(@NotNull JsonNode doc, Long revision) {
    }

    /** A refused stale write: the current game, so the client can decide (never overwrite a newer story). */
    public record GameConflict(String code, Game current) {
    }

    public record Spend(@NotNull @Pattern(regexp = "market|bistro") String kind, @Size(max = 8) List<@Pattern(regexp = "^[a-z_]{1,24}$") String> items, boolean sale) {
    }

    /**
     * One report from the client: the action that caused it, the unique rewards V3 granted, and what V3 added to credits and
     * skill XP in total. The server grants unique rewards from its own table (once each) and treats only the rest as a
     * repeatable earning, bounded per report and per day.
     */
    public record ClaimBatch(@NotNull @Pattern(regexp = "^[A-Za-z0-9:_\\-]{1,64}$") String source,
                             @Size(max = 24) List<@Pattern(regexp = "^[a-z0-9_:]{3,96}$") String> uniques,
                             int credits, Map<String, Integer> xp, @Size(max = 4) List<@Valid Spend> spent,
                             @Pattern(regexp="^[a-zA-Z0-9_-]{8,64}$") String requestId) {
        public ClaimBatch(String source,List<String> uniques,int credits,Map<String,Integer> xp,List<Spend> spent) {
            this(source,uniques,credits,xp,spent,null);
        }
    }

    public record ClaimRequest(@NotNull @Size(min = 1, max = 32) List<@Valid ClaimBatch> batches,
                               @Valid SaveGameRequest checkout) {
        public ClaimRequest(List<ClaimBatch> batches) { this(batches, null); }
    }

    /** What a claim did: granted keys and amounts, refused keys with their reason. */
    public record ClaimResult(Wallet wallet, List<String> granted, Map<String, String> refused, int activityCredits, int activityXp,
                              Long revision) {
        public ClaimResult(Wallet wallet, List<String> granted, Map<String,String> refused, int activityCredits, int activityXp) {
            this(wallet, granted, refused, activityCredits, activityXp, null);
        }
    }

    public record PurchaseRequest(@NotNull @Pattern(regexp = "^[a-z_]{1,40}$") String storeId,
                                  @NotNull @Pattern(regexp = "^[A-Za-z0-9_\\-]{1,96}$") String sku,
                                  @NotNull @Pattern(regexp = "^[A-Za-z0-9_\\-]{8,64}$") String requestId) {
    }

    public record PurchaseResult(Wallet wallet, String instanceId, int price, String itemType) {
    }

    public record SaleRequest(@NotNull @Pattern(regexp = "^ec_[0-9a-f]{20}$") String instanceId) {
    }

    public record WorkshopRequest(@NotNull @Pattern(regexp="^[a-zA-Z0-9_-]{8,64}$") String requestId,
                                  @NotNull Long revision, @NotNull JsonNode action) {}
    public record WorkshopResult(Wallet wallet, boolean ok, String msg) {}

    public record SaleResult(Wallet wallet, int refund) {
    }
}
