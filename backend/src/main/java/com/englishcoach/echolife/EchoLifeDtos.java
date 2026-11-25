package com.englishcoach.echolife;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotNull;

import java.time.Instant;

/**
 * Wire shapes of the Echo Life world save (V129).
 *
 * <p>{@code World.state} holds {@code v}, {@code places}, {@code doors}, {@code objects}, and an optional strictly
 * validated per-account {@code avatar} document (&le; 24 KB within the 128 KB JSONB row) carrying Character Creator
 * customization (hair, skin/iris/lip palette, facial morphs &amp; makeup, body sliders, 1..8 outfits, identity, and
 * server-verified {@code wireCode}).
 */
public final class EchoLifeDtos {

    private EchoLifeDtos() {
    }

    /**
     * The learner's world document. {@code revision} 0 = nothing saved yet; {@code updatedAt} null then.
     * {@code saveVersion} names the document schema the server answers with (older documents are upgraded on read).
     */
    public record World(int saveVersion, long revision, JsonNode state, Instant updatedAt) {
    }

    /** {@code revision}: the revision this write was based on (0 or null for the first save). */
    public record SaveWorldRequest(@NotNull JsonNode state, Long revision) {
    }

    /** A refused stale write: the current document, so the client can merge its newer entries and retry. */
    public record Conflict(String code, World current) {
    }
}
