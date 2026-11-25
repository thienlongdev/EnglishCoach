package com.englishcoach.writing.dto;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DailyWordCountDto {
    private String dayCode;     // "T2", "T3", ..., "CN"
    private String dayName;     // "Thứ 2", ..., "Chủ nhật"
    private int dayOfWeek;      // 1 = Monday, ..., 7 = Sunday
    private int wordCount;

    @JsonProperty("isToday")
    @JsonAlias({"isToday", "today"})
    private boolean isToday;

    @JsonProperty("isPast")
    @JsonAlias({"isPast", "past"})
    private boolean isPast;

    @JsonProperty("today")
    public boolean isTodayAlias() {
        return isToday;
    }

    @JsonProperty("past")
    public boolean isPastAlias() {
        return isPast;
    }
}
