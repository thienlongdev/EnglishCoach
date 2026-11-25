package com.englishcoach.garden.domain;

/**
 * The voluntary Echo guide (pure rules, no storage). One small record per garden says what its owner decided about the
 * starter guide and how far they came; it never changes a coin, an XP point, a crop or a learning fact.
 * <ul>
 *   <li>The invitation is offered once: only to a garden whose owner never decided, never left the old first step
 *   and never planted ({@link #invite}). Showing it already consumes it ({@link Action#SHOWN}), so an interrupted
 *   first visit cannot be asked again.</li>
 *   <li>Progress only moves forward; a completed guide stays completed (a replay is presentation only).</li>
 *   <li>Every way out of the guide (declined, left, finished, or found unfinished on a later visit) lifts the garden
 *   past the old tutorial gate ({@link #ONBOARDING_DONE}), exactly like the former "skip" did.</li>
 * </ul>
 */
public final class GuideEngine {

    public static final int VERSION = 1;
    /** Milestones of the starter guide. */
    public static final int STEPS = 7;
    public static final int ONBOARDING_DONE = 8;

    private GuideEngine() {}

    public enum Status { INVITED, DECLINED, STARTED, EXITED, COMPLETED }

    public enum Action { SHOWN, DECLINE, START, PROGRESS, EXIT, COMPLETE, SETTLE }

    /** {@code status} null = the owner was never asked. */
    public record Guide(Status status, int step) {

        public static final Guide NONE = new Guide(null, 0);

        public Guide {
            step = Math.max(0, Math.min(STEPS, step));
        }
    }

    /** {@code onboardingFloor}: the garden's stored tutorial step is raised to at least this (0 = untouched). */
    public record Outcome(Guide guide, int onboardingFloor) {}

    public static Outcome apply(Guide current, Action action, int step) {
        Guide g = current == null ? Guide.NONE : current;
        Status s = g.status();
        boolean done = s == Status.COMPLETED;
        return switch (action) {
            case SHOWN -> new Outcome(s == null ? new Guide(Status.INVITED, g.step()) : g, 0);
            case DECLINE -> new Outcome(s == null || s == Status.INVITED ? new Guide(Status.DECLINED, g.step()) : g, ONBOARDING_DONE);
            case START -> new Outcome(done ? g : new Guide(Status.STARTED, g.step()), 1);
            case PROGRESS -> new Outcome(done ? g : new Guide(Status.STARTED, Math.max(g.step(), step)), 1);
            case EXIT -> new Outcome(s == Status.STARTED ? new Guide(Status.EXITED, g.step()) : g, ONBOARDING_DONE);
            case COMPLETE -> new Outcome(new Guide(Status.COMPLETED, STEPS), ONBOARDING_DONE);
            case SETTLE -> new Outcome(s == Status.INVITED ? new Guide(Status.DECLINED, g.step())
                    : s == Status.STARTED ? new Guide(Status.EXITED, g.step()) : g, ONBOARDING_DONE);
        };
    }

    /**
     * A genuinely new garden: never asked, still on the very first step of the old tutorial and nothing was ever planted.
     * A garden that existed before the guide and was played in any way is never invited (its owner opens Help instead).
     */
    public static boolean invite(Guide guide, int onboardingStep, long plantings) {
        return (guide == null || guide.status() == null) && onboardingStep == 0 && plantings == 0;
    }
}
