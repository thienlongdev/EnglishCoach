package com.englishcoach.speaking.arena;

import java.util.Map;
import java.util.Set;

/** Only authorization crosses the application server. Media never does. */
public interface ArenaVoice {
    boolean available();
    String url();
    String token(String room, String identity, boolean publish);
    void create(String room, int capacity);
    /** Removes a participant from the provider room. Returns true if present (HTTP 200), false if provider confirmed not-found (HTTP 404). */
    boolean remove(String room, String identity);
    void close(String room);
    /** Who the provider shows connected in this room: identity to when it joined, in milliseconds. Empty: nobody (or no such room). Null: the provider could not say. */
    default Map<String, Long> participants(String room) { return null; }
    /** Evicts one identity from local admission tracking without a provider request. */
    default void evictIdentity(String mediaRoom, String identity) {}
    /** Reconciles local admission tracking for a room against identities that remain active or pending connection. */
    default void reconcileRoom(String mediaRoom, Set<String> activeIdentities) {}
}
