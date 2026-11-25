package com.englishcoach.ai.dto;

import java.util.List;

/**
 * A structured result shown under Echo's message. Built only by server tools from authorised data.
 * Types: {@code resources} (lessons / topics with an open button), {@code stats} (label / value rows), {@code tasks}
 * (today's Learning Path), {@code confirm} (a prepared change the learner must confirm; {@code token} is single use),
 * {@code memory} (what Echo just remembered).
 */
public record EchoCard(String type, String title, List<Item> items, String token, String note) {

    /** {@code href} is always a path from {@code EchoDestinations}; the client re-validates it against its allow-list. */
    public record Item(String title, String subtitle, String meta, String href, String status) {}

    public static EchoCard of(String type, String title, List<Item> items, String note) {
        return new EchoCard(type, title, items == null ? List.of() : List.copyOf(items), null, note);
    }
}
