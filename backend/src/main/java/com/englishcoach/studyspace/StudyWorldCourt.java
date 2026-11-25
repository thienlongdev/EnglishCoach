package com.englishcoach.studyspace;

import java.util.Map;

/** Riverside Park's two-sided badminton net. The containing invite room serializes all transitions. */
final class StudyWorldCourt {
    static final int GOAL = 6, FLIGHT_MS = 1500;
    private static final int GRACE_MS = 12000, LATE_MS = 900;
    private static final double NET_Z = 3.7, DEPTH = 1.9;
    record Intent(String action, long revision) {}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    record View(long revision, String phase, Long north, Long south, int turn, int returns, int goal,
                double netX, double netZ, double depth, double fromX, double toX,
                long hitAt, long serverNow, int flightMs) {}
    private enum Phase { OPEN, WAITING, SERVE, FLIGHT, PAUSED, MISSED, COMPLETE }

    private final Long[] seats = new Long[2];
    private final long[] lastPresent = new long[2];
    private Phase phase = Phase.OPEN;
    private long revision = 1, hitAt;
    private int turn, returns;
    private double fromX, toX;

    // cityPlan places the park waypoint at -h+.5 and the net at the eastern wall +32 m.
    private static double netX(StudyWorldPresence.Pose p) { return 45.2 + p.planSize(); }
    private static boolean atCourt(StudyWorldPresence.Pose p) {
        return p != null && "park".equals(p.zone()) && Math.abs(p.y()) <= 1.1
            && Math.abs(p.x()-netX(p)) <= 4 && Math.abs(p.z()-NET_Z) <= 4.5;
    }
    private static int side(StudyWorldPresence.Pose p) { return p.z() < NET_Z ? 0 : 1; }
    private static double sideZ(int side) { return NET_Z + (side == 0 ? -DEPTH : DEPTH); }
    private int seat(long user) {
        for (int i=0; i<2; i++) if (seats[i]!=null && seats[i]==user) return i;
        return -1;
    }
    private void phase(Phase next) {
        if (phase!=next) { phase=next; revision++; }
    }
    private void restart() {
        returns=0; turn=0; fromX=0; toX=0; hitAt=0;
        phase(seats[0]==null && seats[1]==null ? Phase.OPEN :
            seats[0]==null || seats[1]==null ? Phase.WAITING : Phase.SERVE);
    }
    private void vacate(int i) { seats[i]=null; lastPresent[i]=0; revision++; restart(); }

    void advance(Map<Long,StudySharedService.Member> members,long now) {
        int live=0;
        for (int i=0;i<2;i++) {
            if (seats[i]==null) continue;
            var member=members.get(seats[i]);
            if (member==null) { vacate(i); continue; }
            var presence=member.world;
            // Pause before an unanswered shot can land when a player's transport goes silent.
            boolean fresh=presence.pose!=null && now-presence.seen<1200;
            if (fresh && !atCourt(presence.pose)) { vacate(i); continue; }
            if (fresh) { lastPresent[i]=presence.seen; live++; }
            else if (now-lastPresent[i]>=GRACE_MS) vacate(i);
        }
        if (seats[0]==null || seats[1]==null) return;
        if (phase==Phase.COMPLETE || phase==Phase.MISSED) return;
        if (live<2) { phase(Phase.PAUSED); return; }
        if (phase==Phase.PAUSED) { hitAt=0; fromX=0; toX=0; phase(Phase.SERVE); }
        if (phase==Phase.FLIGHT && now-hitAt>FLIGHT_MS+LATE_MS) phase(Phase.MISSED);
    }

    void act(long user,StudyWorldPresence.Pose p,Intent intent,long now) {
        if (intent==null || intent.revision()!=revision || !atCourt(p)) return;
        int own=seat(user), side=side(p);
        if ("leave".equals(intent.action()) && own>=0) { vacate(own); return; }
        if ("join".equals(intent.action()) && own<0 && seats[side]==null
                && Math.abs(p.z()-NET_Z)>=.6 && Math.hypot(p.x()-netX(p),p.z()-sideZ(side))<=2.6) {
            seats[side]=user; lastPresent[side]=now; revision++; restart(); return;
        }
        if (own<0 || side!=own) return;
        if ("replay".equals(intent.action()) && (phase==Phase.COMPLETE || phase==Phase.MISSED)) {
            restart(); return;
        }
        if (!"strike".equals(intent.action()) || own!=turn || (phase!=Phase.SERVE && phase!=Phase.FLIGHT)) return;
        if (Math.hypot(p.x()-netX(p)-toX,p.z()-sideZ(own))>2.1) return;
        if (phase==Phase.FLIGHT) {
            if (now-hitAt<FLIGHT_MS*2/3 || now-hitAt>FLIGHT_MS+LATE_MS) return;
            if (++returns==GOAL) { phase(Phase.COMPLETE); return; }
        }
        fromX=toX; toX=(returns%3-1)*.85; turn=1-own; hitAt=now;
        phase=Phase.FLIGHT; revision++;
    }

    View view(StudyWorldPresence.Pose p,long now) {
        if (!atCourt(p)) return null;
        return new View(revision,phase.name(),seats[0],seats[1],turn,returns,GOAL,netX(p),NET_Z,DEPTH,
            fromX,toX,hitAt,now,FLIGHT_MS);
    }
}
