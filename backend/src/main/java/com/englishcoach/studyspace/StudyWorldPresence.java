package com.englishcoach.studyspace;

import com.englishcoach.common.AvatarLookCode;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** All coordinates are metres relative to the named public zone's waypoint. Never persisted. */
final class StudyWorldPresence {
    static final long EXPIRE_MS = 3500;
    static final long EMOTE_COOLDOWN_MS = 900;
    static final long EMOTE_TTL_MS = 1800;
    static final long QUICK_CHAT_COOLDOWN_MS = 1500;
    static final long QUICK_CHAT_TTL_MS = 4000;

    private static final Set<String> PUBLIC_ZONES = Set.of("street", "park", "campus", "fair",
            "greenway", "botanical", "lantern_garden", "fountain_plaza", "cafe", "bistro",
            "market", "electronics_shop", "furniture_shop", "clothing_shop", "vehicle_dealer",
            "home_center", "repair_shop", "library", "atelier");
    static final Set<String> VEHICLE_MODELS = Set.of(
            "mango", "lotus", "river", "halo", "vesper", "cafe_racer", "bike");
    static final Set<String> EMOTES = Set.of(
            "wave", "clap", "cheer", "laugh", "dance", "point", "toast");
    static final Set<String> QUICK_CHATS = Set.of(
            "qc_hi", "qc_good_morning", "qc_nice_look", "qc_study_together",
            "qc_bistro_coffee", "qc_library_quiet", "qc_great_job", "qc_practice_english",
            "qc_follow_me", "qc_wait_a_sec", "qc_badminton", "qc_basketball",
            "qc_listen_music", "qc_take_photo", "qc_thank_you", "qc_bye");
    private static final Pattern HEX_COLOR = Pattern.compile("^#[0-9a-fA-F]{6}$");

    static double round3(double v) {
        return Math.rint(v * 1000.0) / 1000.0;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record VehiclePose(String model, String paint, int lights) {
        boolean valid() {
            return model != null && VEHICLE_MODELS.contains(model)
                    && paint != null && HEX_COLOR.matcher(paint).matches()
                    && lights >= 0 && lights <= 15;
        }
        VehiclePose normalized() {
            return new VehiclePose(model, paint.toLowerCase(Locale.ROOT), lights);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Pose(String zone, double x, double y, double z, double yaw, String model, Double roomSize, String posture, VehiclePose vehicle) {
        Pose(String zone, double x, double y, double z, double yaw, String model, Double roomSize, String posture) {
            this(zone, x, y, z, yaw, model, roomSize, posture, null);
        }
        Pose(String zone, double x, double y, double z, double yaw, String model, Double roomSize) {
            this(zone, x, y, z, yaw, model, roomSize, null, null);
        }
        Pose(String zone, double x, double y, double z, double yaw, String model) {
            this(zone, x, y, z, yaw, model, null, null, null);
        }
        double planSize() { return roomSize == null ? 6 : roomSize; }
        boolean valid() {
            return zone != null && PUBLIC_ZONES.contains(zone) && Double.isFinite(x) && Double.isFinite(y) &&
                    Double.isFinite(z) && Double.isFinite(yaw) && Math.abs(x) <= 500 &&
                    Math.abs(z) <= 500 && Math.abs(y) <= 12 && Math.abs(yaw) <= 2 * Math.PI &&
                    planSize() >= 4 && planSize() <= 9 && ("KAI".equals(model) || "LYRA".equals(model))
                    && (posture == null || switch (posture) {
                        case "seated", "mounted", "airborne" -> true;
                        default -> false;
                    })
                    && (vehicle == null || ("mounted".equals(posture) && vehicle.valid()));
        }
        Pose quantized() {
            Double rs = roomSize == null ? null : round3(roomSize);
            VehiclePose vp = vehicle == null ? null : vehicle.normalized();
            return new Pose(zone, round3(x), round3(y), round3(z), round3(yaw), model, rs, posture, vp);
        }
        double distanceSq(Pose other) {
            double dx = x - other.x, dz = z - other.z;
            return dx * dx + dz * dz;
        }
    }

    record Input(UUID room, long seq, Pose pose, String emote, StudyWorldEquipment.Intent intent,
                 StudyWorldCourt.Intent court, StudyWorldEvent.Intent event, String look, String quickChat) {
        Input(UUID room, long seq, Pose pose, String emote, StudyWorldEquipment.Intent intent,
              StudyWorldCourt.Intent court, StudyWorldEvent.Intent event) {
            this(room, seq, pose, emote, intent, court, event, null, null);
        }
        Input(UUID room, long seq, Pose pose, String emote, StudyWorldEquipment.Intent intent, StudyWorldCourt.Intent court) {
            this(room, seq, pose, emote, intent, court, null, null, null);
        }
        Input(UUID room, long seq, Pose pose, String emote, StudyWorldEquipment.Intent intent) {
            this(room, seq, pose, emote, intent, null, null, null, null);
        }
        Input(UUID room, long seq, Pose pose, String emote) {
            this(room, seq, pose, emote, null, null, null, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Peer(long id, String name, Pose pose, String emote, long emoteAt,
                String look, String quickChat, Long quickChatAt) {
        Peer(long id, String name, Pose pose, String emote, long emoteAt) {
            this(id, name, pose, emote, emoteAt, null, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    record Frame(UUID room, long seq, List<Peer> peers, List<StudyWorldEquipment.View> equipment, String actionResult,
                 StudyWorldCourt.View court, StudyWorldEvent.View event) {}

    String socket;
    long sequence, seen, emoteAt, quickChatAt;
    Pose pose;
    String emote, look, quickChat;

    void clear() {
        socket = null;
        pose = null;
        emote = null;
        emoteAt = 0;
        look = null;
        quickChat = null;
        quickChatAt = 0;
        sequence = 0;
    }

    boolean accept(String session, Input input, long now) {
        if (socket == null || now - seen >= EXPIRE_MS) clear();
        if (socket != null && (!socket.equals(session) || now - seen < 80)) return false;
        if (input.seq() <= sequence || input.pose() != null && !input.pose().valid()) return false;
        if (input.emote() != null && !EMOTES.contains(input.emote())) return false;
        if (input.quickChat() != null && !QUICK_CHATS.contains(input.quickChat())) return false;
        socket = session;
        seen = now;
        sequence = input.seq();
        pose = input.pose() == null ? null : input.pose().quantized();
        if (input.look() != null) {
            String cleaned = AvatarLookCode.clean(input.look());
            look = cleaned.isEmpty() ? null : cleaned;
        }
        if (pose == null) {
            emote = null;
            quickChat = null;
        } else {
            if (input.emote() != null && (emote == null || now - emoteAt >= EMOTE_COOLDOWN_MS)) {
                emote = input.emote();
                emoteAt = now;
            }
            if (input.quickChat() != null && (quickChat == null || now - quickChatAt >= QUICK_CHAT_COOLDOWN_MS)) {
                quickChat = input.quickChat();
                quickChatAt = now;
            }
        }
        return true;
    }
}
