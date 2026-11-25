package com.englishcoach.flashcard.pvp.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PvPMessage<T> {

    private String type;
    private String roomCode;
    private T payload;
    @Builder.Default
    private long timestamp = System.currentTimeMillis();

    public static <T> PvPMessage<T> of(String type, String roomCode, T payload) {
        return PvPMessage.<T>builder()
                .type(type)
                .roomCode(roomCode)
                .payload(payload)
                .timestamp(System.currentTimeMillis())
                .build();
    }
}
