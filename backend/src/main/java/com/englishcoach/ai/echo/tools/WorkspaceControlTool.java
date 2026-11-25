package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Tool #20 ({@code emit_workspace_control}, {@link Kind#NAVIGATE}):
 * Emits a strictly allow-listed, typed client workspace-control action ({@code theme_mode}, {@code ui_font_scale},
 * {@code ui_locale}, {@code reading_control}, {@code mybooks_open_last}, {@code mybooks_reader}, {@code speaking_control},
 * {@code flashcard_control}, {@code writing_control}, {@code listening_player}, {@code apply_bg_preset},
 * {@code adjust_bg_brightness}, {@code reset_appearance}, {@code open_appearance_studio}, {@code nav_layout},
 * {@code nav_visibility}, {@code world_display}, {@code scroll}, {@code history_back}, {@code dictionary_lookup},
 * {@code music_control}).
 */
@Component
public class WorkspaceControlTool implements EchoTool {

    private static final List<String> ALLOWED_CONTROLS = List.of(
            "theme_mode", "ui_font_scale", "ui_locale", "reading_control",
            "mybooks_open_last", "mybooks_reader", "speaking_control",
            "flashcard_control", "writing_control", "listening_player",
            "apply_bg_preset", "adjust_bg_brightness", "reset_appearance",
            "open_appearance_studio", "nav_layout", "nav_visibility",
            "world_display", "scroll", "history_back",
            "dictionary_lookup", "music_control");

    private static final Set<String> BG_PRESETS = Set.of(
            "pearlescent-abyss", "aurora-flow", "oceanic-glow", "liquid-mesh", "nebula-atmosphere",
            "midnight-sapphire", "violet-dream", "rose-quartz", "emerald-depth", "arctic-crystal");

    private static final Set<String> APPEARANCE_ROOMS = Set.of(
            "background", "worlds", "spatial", "media", "navigation");

    private final ObjectMapper mapper;

    public WorkspaceControlTool(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public String name() {
        return "emit_workspace_control";
    }

    @Override
    public String description() {
        return "Emit a validated English Coach workspace UI control alongside your answer (theme_mode, ui_font_scale, "
                + "ui_locale, reading_control, mybooks_open_last, mybooks_reader, speaking_control, flashcard_control, "
                + "writing_control, listening_player, apply_bg_preset, adjust_bg_brightness, reset_appearance, "
                + "open_appearance_studio, nav_layout, nav_visibility, world_display, scroll, history_back, "
                + "dictionary_lookup, music_control). Use only when the learner asked to adjust the workspace.";
    }

    @Override
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("control", EchoToolRegistry.enumOf("Allow-listed workspace control kind", ALLOWED_CONTROLS));
        props.put("mode", EchoToolRegistry.str("Mode/value (e.g. dark/light/system, horizontal/vertical, show/hide, fullscreen/floating, down/up/top/bottom, play/pause/replay)", 32));
        props.put("room", EchoToolRegistry.enumOf("Optional Appearance Studio room", List.of("background", "worlds", "spatial", "media", "navigation")));
        props.put("target", EchoToolRegistry.enumOf("Optional world ('odyssey' or 'cosmos') or scroll target", List.of("odyssey", "cosmos", "down", "up", "top", "bottom")));
        props.put("cefr", EchoToolRegistry.enumOf("Optional CEFR filter", List.of("A1", "A2", "B1", "B2", "C1", "C2")));
        props.put("tab", EchoToolRegistry.enumOf("Optional reading/writing/speaking/world tab",
                List.of("library", "mybooks", "bilingual", "speed", "translation", "sentence-lab", "typing", "coach", "portfolio", "practice", "profile", "overview", "pronunciation", "history", "odyssey", "cosmos")));
        props.put("preset_id", EchoToolRegistry.str("Optional Background Studio preset id", 40));
        props.put("query", EchoToolRegistry.str("Optional dictionary word, book title, or search query", 80));
        props.put("delta", EchoToolRegistry.integer("Optional signed step (-30 to 30) for font scale / background brightness", -30, 30));
        props.put("scenario_id", EchoToolRegistry.integer("Optional validated speaking scenario or deck id", 1, 2_000_000_000));
        return EchoToolRegistry.schema(props, List.of("control"));
    }

    @Override
    public Kind kind() {
        return Kind.NAVIGATE;
    }

    @Override
    public String status(boolean vi) {
        return vi ? "Echo đang điều chỉnh không gian học…" : "Echo is adjusting your workspace…";
    }

    @Override
    public String run(EchoTurn turn, JsonNode args) throws Exception {
        if (CaMeLPolicyEngine.isBlockedByGuard(turn)) {
            return mapper.writeValueAsString(Map.of("emitted", false, "dispatched", false, "reason", "blocked_by_guard"));
        }

        String control = args.get("control").asText();
        if (!CaMeLPolicyEngine.canEmitWorkspaceControl(turn, control)) {
            return mapper.writeValueAsString(Map.of("emitted", false, "dispatched", false, "reason", "not_authorized_by_learner"));
        }

        Map<String, Object> intent = buildValidatedIntent(control, args);
        if (intent == null) {
            return mapper.writeValueAsString(Map.of("emitted", false, "dispatched", false, "reason", "invalid_control_parameters"));
        }

        String label = labelFor(control, turn.vi());
        turn.action(EchoAction.workspaceControl(intent, label, true));
        return mapper.writeValueAsString(Map.of(
                "emitted", true,
                "dispatched", true,
                "control", control,
                "auto", true,
                "label", label));
    }

    private static Map<String, Object> buildValidatedIntent(String control, JsonNode args) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", control);
        String mode = args.path("mode").asText("").trim().toLowerCase(Locale.ROOT);
        String room = args.path("room").asText("").trim().toLowerCase(Locale.ROOT);
        String target = args.path("target").asText("").trim().toLowerCase(Locale.ROOT);
        String cefr = args.path("cefr").asText("").trim().toUpperCase(Locale.ROOT);
        String tab = args.path("tab").asText("").trim().toLowerCase(Locale.ROOT);
        String query = args.path("query").asText("").trim();
        Integer delta = args.has("delta") ? args.get("delta").asInt() : null;
        Long scenarioId = args.has("scenario_id") ? args.get("scenario_id").asLong() : null;

        switch (control) {
            case "theme_mode" -> {
                if (!Set.of("light", "dark", "system").contains(mode)) return null;
                m.put("mode", mode);
            }
            case "ui_font_scale" -> {
                int step = delta == null || delta == 0 ? 1 : Math.max(-4, Math.min(4, delta));
                m.put("delta", Math.round(step * 8) / 100.0);
            }
            case "ui_locale" -> {
                if (!Set.of("vi", "en").contains(mode)) return null;
                m.put("locale", mode);
            }
            case "reading_control" -> {
                if (Set.of("library", "mybooks", "bilingual", "speed").contains(tab)) m.put("tab", tab);
                if (!cefr.isEmpty()) m.put("filterLevel", cefr);
                if (!query.isEmpty()) m.put("searchQuery", query);
                if (delta != null && delta != 0) m.put("fontDelta", Math.max(-10, Math.min(10, delta * 2)));
                if (m.size() == 1) return null;
            }
            case "mybooks_open_last" -> {
                if (!query.isEmpty()) m.put("query", query);
            }
            case "mybooks_reader" -> {
                if (Set.of("paper", "white", "dark", "oled").contains(mode)) m.put("theme", mode);
                if (Set.of("next", "prev").contains(mode)) m.put("page", mode);
                if (delta != null && delta != 0) m.put("fontDelta", Math.max(-10, Math.min(10, delta * 2)));
                if (m.size() == 1) return null;
            }
            case "speaking_control" -> {
                if ("practice".equals(tab) || "profile".equals(tab)) m.put("view", tab);
                else if (Set.of("overview", "pronunciation", "history").contains(tab)) {
                    m.put("view", "profile");
                    m.put("sub", tab);
                }
                if (Set.of("shadowing", "roleplay", "assessment", "topic").contains(mode)) m.put("mode", mode);
                else if ("profile".equals(mode) || "practice".equals(mode)) m.put("view", mode);
                else if (Set.of("overview", "pronunciation", "history").contains(mode)) {
                    m.put("view", "profile");
                    m.put("sub", mode);
                }
                if (!cefr.isEmpty()) m.put("cefr", cefr);
                if (!query.isEmpty()) m.put("query", query);
                if (scenarioId != null && scenarioId > 0) m.put("scenarioId", scenarioId);
                if (m.size() == 1) return null;
            }
            case "flashcard_control" -> {
                if (Set.of("due", "learned", "catalog").contains(mode)) m.put("mode", mode);
                if (scenarioId != null && scenarioId > 0) m.put("deckId", scenarioId);
                if (!query.isEmpty()) m.put("searchQuery", query);
                if (m.size() == 1) return null;
            }
            case "writing_control" -> {
                if (Set.of("translation", "sentence-lab", "typing", "coach", "portfolio").contains(tab)) m.put("room", tab);
                if (!mode.isEmpty()) m.put("mode", mode);
                if (m.size() == 1) return null;
            }
            case "listening_player" -> {
                if (!Set.of("play", "pause", "toggle", "replay", "toggle_transcript", "switch_dictation", "switch_overview").contains(mode)) {
                    return null;
                }
                m.put("command", mode);
            }
            case "apply_bg_preset" -> {
                String preset = args.path("preset_id").asText("").trim().toLowerCase(Locale.ROOT);
                if (!BG_PRESETS.contains(preset)) return null;
                m.put("presetId", preset);
            }
            case "adjust_bg_brightness" -> {
                int resolved;
                if (delta != null && delta != 0) {
                    resolved = Math.abs(delta) <= 4 ? delta * 15 : Math.max(-30, Math.min(30, delta));
                } else if (Set.of("darken", "darker", "dim", "down").contains(mode)) {
                    resolved = -15;
                } else {
                    resolved = 15;
                }
                m.put("delta", resolved);
            }
            case "reset_appearance" -> {
                // No extra args needed
            }
            case "open_appearance_studio" -> {
                String chosenRoom = !room.isEmpty() ? room : mode;
                if (!chosenRoom.isEmpty()) {
                    if (!APPEARANCE_ROOMS.contains(chosenRoom)) return null;
                    m.put("room", chosenRoom);
                }
            }
            case "nav_layout" -> {
                if ("horizontal".equals(mode) || "dock".equals(mode)) {
                    m.put("layout", "dock");
                    m.put("mode", "horizontal");
                } else if ("vertical".equals(mode) || "sidebar".equals(mode)) {
                    m.put("layout", "sidebar");
                    m.put("mode", "vertical");
                } else {
                    return null;
                }
            }
            case "nav_visibility" -> {
                if ("show".equals(mode) || "pinned".equals(mode) || "pin".equals(mode)) {
                    m.put("visibility", "pinned");
                    m.put("mode", "show");
                } else if ("hide".equals(mode) || "autohide".equals(mode) || "auto-hide".equals(mode) || "auto_hide".equals(mode)) {
                    m.put("visibility", "autohide");
                    m.put("mode", "hide");
                } else {
                    return null;
                }
            }
            case "world_display" -> {
                String world = Set.of("odyssey", "cosmos").contains(target) ? target
                        : (Set.of("odyssey", "cosmos").contains(tab) ? tab : null);
                if (world == null) return null;
                String display;
                String normMode;
                if ("fullscreen".equals(mode) || "immersive".equals(mode)) {
                    display = "immersive";
                    normMode = "fullscreen";
                } else if ("floating".equals(mode) || "embedded".equals(mode)) {
                    display = "embedded";
                    normMode = "floating";
                } else {
                    return null;
                }
                m.put("world", world);
                m.put("display", display);
                m.put("mode", normMode);
            }
            case "scroll" -> {
                String dir = Set.of("down", "up", "top", "bottom").contains(mode) ? mode
                        : (Set.of("down", "up", "top", "bottom").contains(target) ? target : null);
                if (dir == null) return null;
                m.put("target", dir);
            }
            case "history_back" -> {
                // No extra args needed
            }
            case "dictionary_lookup" -> {
                if (!query.isEmpty() && !query.matches("[A-Za-z][A-Za-z0-9' -]{0,59}")) return null;
                m.put("word", query);
            }
            case "music_control" -> {
                if (!Set.of("play", "pause", "next", "prev", "volume_up", "volume_down", "shuffle").contains(mode)) return null;
                m.put("command", mode);
            }
            default -> {
                return null;
            }
        }
        return m;
    }

    private static String labelFor(String control, boolean vi) {
        return switch (control) {
            case "theme_mode" -> vi ? "Đổi chế độ hiển thị" : "Switch theme";
            case "ui_font_scale" -> vi ? "Điều chỉnh cỡ chữ" : "Adjust font size";
            case "adjust_bg_brightness" -> vi ? "Chỉnh độ sáng nền" : "Adjust background brightness";
            case "reset_appearance" -> vi ? "Khôi phục giao diện mặc định" : "Reset appearance";
            case "open_appearance_studio" -> vi ? "Mở cài đặt giao diện" : "Open Appearance Studio";
            case "nav_layout" -> vi ? "Đổi bố cục thanh điều hướng" : "Switch navigation layout";
            case "nav_visibility" -> vi ? "Ẩn/hiện thanh điều hướng" : "Toggle navigation visibility";
            case "world_display" -> vi ? "Đổi chế độ hiển thị thế giới 3D" : "Switch 3D world display";
            case "scroll" -> vi ? "Cuộn trang" : "Scroll page";
            case "history_back" -> vi ? "Quay lại trang trước" : "Go back";
            case "reading_control" -> vi ? "Tùy chỉnh trang Đọc" : "Adjust Reading";
            case "mybooks_open_last" -> vi ? "Mở sách đọc gần nhất" : "Resume last book";
            case "speaking_control" -> vi ? "Chuẩn bị Luyện nói" : "Prepare Speaking";
            case "flashcard_control" -> vi ? "Mở bộ Thẻ từ vựng" : "Open Flashcards";
            case "writing_control" -> vi ? "Mở phòng Viết" : "Open Writing room";
            default -> vi ? "Điều chỉnh không gian học" : "Workspace control";
        };
    }
}
