package com.englishcoach.garden.application;

/**
 * Phase 3G port to the product's notification centre. The garden composes the text from the take it just recorded and
 * hands it over inside the same transaction; the notification module owns storage, read state and delivery.
 */
public interface SocialNotifier {

    /**
     * @param ownerId   the island owner who is told (never the taker)
     * @param dedupeKey one notification per recorded take
     * @param actionUrl an internal route to the garden's activity record
     */
    void taken(long ownerId, String dedupeKey, String title, String body, String actionUrl);
}
