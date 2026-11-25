package com.englishcoach.avatarframe.service;

/**
 * Whether a frame lineage is offered to a user. Implemented by the module that owns the lineage (the garden for
 * {@code GARDEN}): a learner without access to that feature does not see its frames in the catalogue — unless they own
 * one, which always stays visible and usable. With no implementation every lineage is offered to everyone.
 */
public interface FrameAudience {

    boolean offered(Long userId, String lineage);
}
