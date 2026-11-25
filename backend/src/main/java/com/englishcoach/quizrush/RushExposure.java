package com.englishcoach.quizrush;

import java.util.*;

/**
 * The question sources an account met recently in Echo Quiz Rush (Solo journeys and competitive races), most recent
 * first. Question selection avoids them so repeated runs keep meeting new English; never a scoring input.
 */
@FunctionalInterface
public interface RushExposure {
    /** Ordered most recent first (iteration order is the recency). */
    Set<String> recent(long user);
}
