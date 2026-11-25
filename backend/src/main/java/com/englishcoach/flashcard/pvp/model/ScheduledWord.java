package com.englishcoach.flashcard.pvp.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ScheduledWord {

    private int seq;
    private long wordId;
    private String word;
    private String ipa;
    private String vietnamese;
    @Builder.Default
    private List<String> targetAnswers = new ArrayList<>();
    private int lane;
    private long spawnAtMs;
    private long fallDurationMs;
    @Builder.Default
    @JsonProperty("isGarbage")
    private boolean isGarbage = false;
    @Builder.Default
    @JsonProperty("isGolden")
    private boolean isGolden = false;
    private String targetPlayerId;

    @JsonProperty("isGolden")
    public boolean isGolden() {
        return isGolden;
    }

    @JsonProperty("isGarbage")
    public boolean isGarbage() {
        return isGarbage;
    }

    // The same two flags under their short names. The methods are deliberately not bean getters: a second getter for
    // the property that isGolden() / isGarbage() already define is an ambiguous definition (Jackson 2.21 refuses it).
    @JsonProperty(value = "golden", access = JsonProperty.Access.READ_ONLY)
    public boolean goldenAlias() {
        return isGolden;
    }

    @JsonProperty(value = "garbage", access = JsonProperty.Access.READ_ONLY)
    public boolean garbageAlias() {
        return isGarbage;
    }
}
