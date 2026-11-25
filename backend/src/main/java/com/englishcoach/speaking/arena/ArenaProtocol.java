package com.englishcoach.speaking.arena;

import java.util.*;

public final class ArenaProtocol {
    private ArenaProtocol() {}
    public enum Mode { DUEL, TEAM, GUIDED, FREE }
    public enum Phase { LOBBY, PREPARE, TALK, REVIEW, FREE, FINISHED }

    public record Command(UUID requestId, UUID roomId, String code, Mode mode, String nickname, String hero,
                          UUID target, Integer team, Integer points, String reason, Integer prompt,
                          Boolean value, Double x, Double z, Double yaw, Long sequence,
                          String look, String title, String topic, Integer capacity,
                          String item, Double aux, String place, Double throttle, Double steering) {
        public Command(UUID requestId, UUID roomId, String code, Mode mode, String nickname, String hero,
                       UUID target, Integer team, Integer points, String reason, Integer prompt, Boolean value,
                       Double x, Double z, Double yaw, Long sequence, String look, String title, String topic,
                       Integer capacity, String item, Double aux, String place) {
            this(requestId, roomId, code, mode, nickname, hero, target, team, points, reason, prompt, value, x, z, yaw, sequence, look, title, topic, capacity, item, aux, place, null, null);
        }
        public Command(UUID requestId, UUID roomId, String code, Mode mode, String nickname, String hero,
                       UUID target, Integer team, Integer points, String reason, Integer prompt,
                       Boolean value, Double x, Double z, Double yaw, Long sequence,
                       String look, String title, String topic, Integer capacity) {
            this(requestId, roomId, code, mode, nickname, hero, target, team, points, reason, prompt, value, x, z, yaw, sequence, look, title, topic, capacity, null, null, null);
        }
        public Command(UUID requestId, UUID roomId, String code, Mode mode, String nickname, String hero,
                       UUID target, Integer team, Integer points, String reason, Integer prompt,
                       Boolean value, Double x, Double z, Double yaw, Long sequence,
                       String look, String title, String topic, Integer capacity, String item, Double aux) {
            this(requestId, roomId, code, mode, nickname, hero, target, team, points, reason, prompt, value, x, z, yaw, sequence, look, title, topic, capacity, item, aux, null);
        }
        public Command(UUID requestId, UUID roomId, String code, Mode mode, String nickname, String hero,
                       UUID target, Integer team, Integer points, String reason, Integer prompt,
                       Boolean value, Double x, Double z, Double yaw, Long sequence) {
            this(requestId, roomId, code, mode, nickname, hero, target, team, points, reason, prompt, value, x, z, yaw, sequence, null, null, null, null, null, null, null);
        }
    }

    public record BoatState(String id, double x, double z, double yaw, double rowPhase,
                            UUID rower, UUID passenger, long sequence, long sampledAt,
                            boolean engine, double throttle, double steering, double speed) {}

    public record Player(UUID id, long userId, String name, String hero, int team, boolean ready, boolean online,
                         boolean moderated, boolean canSpeak, String voiceIdentity, double x, double z, double yaw,
                         String gesture, String look, long gestureAt, long sequence, long sampledAt,
                         long jumpAt, double jumpFloor, double supportY, double jumpSpeed,
                         String seat, String boat, String boatRole, String artifact, int artifactTurn,
                         double diveDepth) {
        public Player(UUID id, long userId, String name, String hero, int team, boolean ready, boolean online,
                      boolean moderated, boolean canSpeak, String voiceIdentity, double x, double z, double yaw,
                      String gesture, String look, long gestureAt, long sequence, long sampledAt,
                      long jumpAt, double jumpFloor, double supportY, double jumpSpeed,
                      String seat, String boat, String boatRole, String artifact, int artifactTurn) {
            this(id, userId, name, hero, team, ready, online, moderated, canSpeak, voiceIdentity, x, z, yaw,
                    gesture, look, gestureAt, sequence, sampledAt, jumpAt, jumpFloor, supportY, jumpSpeed,
                    seat, boat, boatRole, artifact, artifactTurn, 0.0);
        }
        public Player(UUID id, long userId, String name, String hero, int team, boolean ready, boolean online,
                      boolean moderated, boolean canSpeak, String voiceIdentity, double x, double z, double yaw,
                      String gesture, String look, long gestureAt, long sequence, long sampledAt,
                      long jumpAt, double jumpFloor, double supportY, double jumpSpeed, String seat) {
            this(id, userId, name, hero, team, ready, online, moderated, canSpeak, voiceIdentity, x, z, yaw,
                    gesture, look, gestureAt, sequence, sampledAt, jumpAt, jumpFloor, supportY, jumpSpeed,
                    seat, null, null, null, 0, 0.0);
        }
    }

    /** Where a table object rests when nobody holds it: on a table (its id), placed by the server. */
    public record ItemState(String id, String table, double x, double z, double y, double yaw) {}

    public record Award(int round, int team, int points, String reason) {}

    public record State(UUID roomId, String code, Mode mode, Phase phase, UUID host, UUID self, UUID speaker,
                        long revision, long serverTime, long deadline, int round, int prompt,
                        int coral, int lagoon, List<Player> players, List<Award> awards,
                        boolean publicMatch, int capacity, String title, String topic, boolean inviteOnly,
                        List<BoatState> boats, List<String> beacons, List<ItemState> items) {
        public State(UUID roomId, String code, Mode mode, Phase phase, UUID host, UUID self, UUID speaker,
                     long revision, long serverTime, long deadline, int round, int prompt,
                     int coral, int lagoon, List<Player> players, List<Award> awards,
                     boolean publicMatch, int capacity, String title, String topic, boolean inviteOnly,
                     List<BoatState> boats, List<String> beacons) {
            this(roomId, code, mode, phase, host, self, speaker, revision, serverTime, deadline, round, prompt,
                    coral, lagoon, players, awards, publicMatch, capacity, title, topic, inviteOnly, boats, beacons, List.of());
        }
        public State(UUID roomId, String code, Mode mode, Phase phase, UUID host, UUID self, UUID speaker,
                     long revision, long serverTime, long deadline, int round, int prompt,
                     int coral, int lagoon, List<Player> players, List<Award> awards,
                     boolean publicMatch, int capacity, String title, String topic, boolean inviteOnly) {
            this(roomId, code, mode, phase, host, self, speaker, revision, serverTime, deadline, round, prompt,
                    coral, lagoon, players, awards, publicMatch, capacity, title, topic, inviteOnly, List.of(), List.of());
        }
    }

    public record VoiceRequest(UUID roomId) {}
    public record VoiceTicket(String url, String token, String identity, long expiresAt) {}

    public record Pose(UUID id, long sequence, long sampledAt, double x, double z, double yaw,
                       long jumpAt, double jumpFloor, double supportY, double jumpSpeed,
                       String seat, String boat, String boatRole, double diveDepth) {
        public Pose(UUID id, long sequence, long sampledAt, double x, double z, double yaw,
                    long jumpAt, double jumpFloor, double supportY, double jumpSpeed,
                    String seat, String boat, String boatRole) {
            this(id, sequence, sampledAt, x, z, yaw, jumpAt, jumpFloor, supportY, jumpSpeed, seat, boat, boatRole, 0.0);
        }
        public Pose(UUID id, long sequence, long sampledAt, double x, double z, double yaw,
                    long jumpAt, double jumpFloor, double supportY, double jumpSpeed, String seat) {
            this(id, sequence, sampledAt, x, z, yaw, jumpAt, jumpFloor, supportY, jumpSpeed, seat, null, null, 0.0);
        }
    }

    public record Motion(UUID roomId, long serverTime, List<Pose> players, List<BoatState> boats) {
        public Motion(UUID roomId, long serverTime, List<Pose> players) {
            this(roomId, serverTime, players, List.of());
        }
    }

    public record Event(String type, UUID requestId, String code, State state, Motion motion) {
        public Event(String type, UUID requestId, String code, State state) { this(type, requestId, code, state, null); }
    }
}
