package com.englishcoach.messenger;

import com.englishcoach.messenger.MessengerDtos.*;
import com.englishcoach.messenger.MessengerRepository.Inserted;
import com.englishcoach.messenger.MessengerRepository.Side;
import com.englishcoach.messenger.MessengerRooms.FileRow;
import com.englishcoach.messenger.MessengerRooms.GroupSide;
import com.englishcoach.messenger.MessengerRooms.Reach;
import com.englishcoach.messenger.MessengerRooms.Target;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;

import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * What is the same for a conversation of two and a group: reading its messages, sending (with a reply, with files), reactions, unsending, a person's own choices
 * (mute for a time, pin, archive, mark unread, remove from my list), the shared theme. And groups themselves: who is in, who manages, who may be added.
 *
 * A group is real membership checked on every call: someone not in it gets "not found" for its messages, its files, its people and its picture alike. A group message is
 * told to the people of the group who are online, at most {@link #GROUP_SIZE}; nobody is written to the bell for it.
 */
@Service
public class MessengerRoomService {
    private static final Logger log = LoggerFactory.getLogger(MessengerRoomService.class);
    static final int GROUP_SIZE = 50, GROUPS_PER_PERSON = 100, PINS = 5, TITLE_MAX = 60;
    static final Set<String> THEMES = Set.of("pearl", "ocean", "abyss", "aurora", "lavender", "sunset", "mint", "rose", "midnight", "sand");
    private static final long HOUR = 3_600_000;

    private final MessengerService direct;
    private final MessengerRepository repo;
    private final MessengerRooms rooms;
    private final MessengerFiles files;
    private final MessengerPush push;
    private final TransactionTemplate tx;
    private final MessengerLoad load;
    private final ObjectMapper json = new ObjectMapper();
    /** A conversation never changes kind: remembering it saves a question on every later call. */
    private final Map<UUID, Boolean> kinds = new ConcurrentHashMap<>();
    private record Memo(List<Reach> reach, String name, long until) {}
    private final Map<String, Memo> typingMemo = new ConcurrentHashMap<>();
    private final Map<Long, Long> lastTyping = new ConcurrentHashMap<>();
    private volatile long sweptAt;

    public MessengerRoomService(MessengerService direct, MessengerRepository repo, MessengerRooms rooms, MessengerFiles files, MessengerPush push, TransactionTemplate tx, MessengerLoad load) {
        this.direct = direct;
        this.repo = repo;
        this.rooms = rooms;
        this.files = files;
        this.push = push;
        this.tx = tx;
        this.load = load;
    }

    private static MessengerException fail(int status, String code) { return new MessengerException(status, code); }

    /** A conversation from the side of the person asking: one of the two is set. Not theirs: not found. */
    record Access(UUID id, long me, Side side, GroupSide group) {
        boolean isGroup() { return group != null; }
        long floor() { return group != null ? group.floor() : side.myHidden(); }
        long lastMessage() { return group != null ? group.lastMessageId() : side.lastMessageId(); }
        String myName() { return group != null ? group.myName() : side.myName(); }
        String myPrincipal() { return group != null ? group.myPrincipal() : side.myPrincipal(); }
    }

    Access access(long me, UUID id) {
        Boolean group = kinds.get(id);
        if (!Boolean.TRUE.equals(group)) {
            Optional<Side> side = repo.side(me, id);
            if (side.isPresent()) { remember(id, false); return new Access(id, me, side.get(), null); }
            if (Boolean.FALSE.equals(group)) throw fail(404, "CONVERSATION_NOT_FOUND");
        }
        GroupSide g = rooms.member(me, id).orElseThrow(() -> fail(404, "CONVERSATION_NOT_FOUND"));
        remember(id, true);
        return new Access(id, me, null, g);
    }
    private void remember(UUID id, boolean group) {
        if (kinds.size() > 20_000) kinds.clear();
        kinds.put(id, group);
    }

    /** Everyone of the conversation who is online hears it, the person themself included (their other pages). */
    private void tell(Access a, Event event) {
        if (a.isGroup()) { for (Reach r : rooms.reach(a.id())) push.send(r.principal(), event); return; }
        push.send(a.side().otherPrincipal(), event);
        push.send(a.side().myPrincipal(), event);
    }

    // ── Reading ─────────────────────────────────────────────
    public MessagePage messages(long me, UUID id, Long before, String query, Long downTo) {
        Access a = access(me, id);
        long reach = downTo == null ? 0 : Math.max(0, downTo);
        if (!a.isGroup()) return direct.messages(me, a.side(), before, query, reach);
        int size = reach > 0 ? 240 : 40;
        List<Message> rows = repo.messages(me, id, before == null ? 0 : before, a.floor(), size + 1, query == null ? null : query.trim(), reach);
        boolean more = rows.size() > size;
        List<Message> page = new ArrayList<>(more ? rows.subList(0, size) : rows);
        java.util.Collections.reverse(page);
        return new MessagePage(page, more || (reach > 0 && reach > a.floor() + 1), a.group().readId(), 0, 0);
    }

    public void read(long me, UUID id, long upTo) {
        Access a = access(me, id);
        if (!a.isGroup()) { direct.read(me, a.side(), upTo); return; }
        direct.limit("read", me, 120, 60_000);
        rooms.markGroupRead(me, id, upTo);
        push.send(a.myPrincipal(), Event.read(id, me, upTo));
    }

    // ── Sending ─────────────────────────────────────────────
    public Message send(long me, UUID id, SendRequest request) {
        Access a = access(me, id);
        if (!a.isGroup()) return direct.send(me, a.side(), request);
        if (request == null || request.ref() == null) throw fail(400, "INVALID_REQUEST");
        GroupSide g = a.group();
        if (g.restricted()) return repo.messageByRef(me, request.ref()).orElseThrow(() -> fail(403, "RESTRICTED"));
        boolean carries = request.attachments() != null && !request.attachments().isEmpty();
        String body = MessengerService.clean(request.body(), carries);
        direct.limit("send", me, 40, 60_000);
        if (carries || request.replyTo() != null) {
            Optional<Message> already = repo.messageByRef(me, request.ref());
            if (already.isPresent()) return already.get();
        }
        List<FileRow> attached = direct.filesFor(me, id, request.attachments());
        Long replyTo = direct.replyTarget(id, a.floor(), request.replyTo());
        List<Mention> named = mentionsIn(me, id, body, request.mentions());
        com.fasterxml.jackson.databind.JsonNode note = withMentions(direct.attachmentNote(attached), named);
        Long created = tx.execute(status -> {
            Optional<Inserted> row = rooms.insertGroup(id, me, "TEXT", body, note, request.ref(), replyTo);
            if (row.isEmpty()) return null;
            if (!attached.isEmpty() && rooms.attach(me, id, row.get().id(), attached.stream().map(FileRow::id).toList()) != attached.size()) throw fail(409, "ATTACHMENT_GONE");
            return row.get().id();
        });
        if (created == null) return repo.messageByRef(me, request.ref()).orElseThrow();
        Message message = repo.messageById(me, created).orElseThrow();
        announce(a, message);
        return message;
    }

    /**
     * A group message goes to the people of the group who are online; someone who blocked or restricted its sender gets it without a card. Someone away finds it on
     * the bell when they return: once a day per group and person (the same rule as a conversation of two), never the words, never when they muted the group or
     * would get it quietly. At most {@link #GROUP_SIZE} people, so the work of one message is bounded.
     */
    private void announce(Access a, Message message) {
        Event event = Event.message(a.id(), message, a.group().title());
        String day = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh")).toString();
        Set<Long> named = mentioned(message);
        for (Reach r : rooms.reach(a.id(), message.senderId())) {
            if (r.user() == message.senderId()) { push.send(r.principal(), event); continue; }
            if (push.online(r.principal())) push.send(r.principal(), r.quiet() ? event.quietly() : event);
            // Someone named with "@" hears of it even with the group muted: one bell entry for this message (the store keeps it once), never the words, and
            // never from someone they blocked or restricted. Their own settings for Community notifications still decide (NotificationService). It stands
            // in for the day's ordinary reminder of this group, which is not sent for the same message.
            if (named.contains(r.user()) && !r.quiet())
                direct.remindPerson(r.user(), a.myName() + " đã nhắc đến bạn trong nhóm " + a.group().title() + ".", "/community/messages?c=" + a.id(), "messenger_mention_" + message.id() + "_" + r.user());
            else if (!push.online(r.principal()) && !r.quiet() && !r.muted())
                direct.remindPerson(r.user(), "Có tin nhắn mới trong nhóm " + a.group().title() + ".", "/community/messages?c=" + a.id(), "messenger_group_" + a.id() + "_" + r.user() + "_" + day);
        }
    }

    /** Most people one message may name. */
    static final int MENTIONS = 10;

    /**
     * The "@Name"s of a group message that hold: each names a current member other than the writer, and the member's shown name stands right after an "@" at
     * that place in the body (the client's offset first, else the nearest free place with that name — a cleaned body may have moved it). Never overlapping, at
     * most {@link #MENTIONS}; anything else is dropped (a mention is never trusted from the client alone). One read of the members, only when there is a mention.
     */
    List<Mention> mentionsIn(long me, UUID id, String body, List<Mention> asked) {
        if (asked == null || asked.isEmpty() || body.isEmpty()) return List.of();
        Map<Long, String> names = new java.util.HashMap<>();
        for (MessengerRooms.MemberRow m : rooms.members(me, id)) if (m.person().id() != me) names.put(m.person().id(), m.person().name());
        List<Mention> kept = new ArrayList<>();
        boolean[] used = new boolean[body.length()];
        for (Mention want : asked.stream().limit(MENTIONS * 3L).sorted(java.util.Comparator.comparingInt(Mention::at)).toList()) {
            if (kept.size() >= MENTIONS) break;
            String name = names.get(want.id());
            if (name == null || name.isBlank()) continue;
            String token = "@" + name;
            int at = free(body, token, want.at(), used) ? want.at() : nearest(body, token, want.at(), used);
            if (at < 0) continue;
            for (int i = at; i < at + token.length(); i++) used[i] = true;
            kept.add(new Mention(want.id(), at, token.length()));
        }
        kept.sort(java.util.Comparator.comparingInt(Mention::at));
        return kept;
    }
    private static boolean free(String body, String token, int at, boolean[] used) {
        if (at < 0 || at + token.length() > body.length() || !body.startsWith(token, at)) return false;
        for (int i = at; i < at + token.length(); i++) if (used[i]) return false;
        return true;
    }
    private static int nearest(String body, String token, int near, boolean[] used) {
        int best = -1;
        for (int i = body.indexOf(token); i >= 0; i = body.indexOf(token, i + 1))
            if (free(body, token, i, used) && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
        return best;
    }
    private com.fasterxml.jackson.databind.JsonNode withMentions(com.fasterxml.jackson.databind.JsonNode note, List<Mention> named) {
        if (named.isEmpty()) return note;
        ObjectNode out = note instanceof ObjectNode o ? o : json.createObjectNode();
        var list = out.putArray("mentions");
        for (Mention m : named) list.addObject().put("id", m.id()).put("at", m.at()).put("len", m.len());
        return out;
    }
    /** The people a stored message names (its payload, written by {@link #mentionsIn}). */
    static Set<Long> mentioned(Message message) {
        Set<Long> out = new LinkedHashSet<>();
        if (message.payload() != null && message.payload().has("mentions"))
            for (com.fasterxml.jackson.databind.JsonNode m : message.payload().get("mentions")) if (m.hasNonNull("id")) out.add(m.get("id").asLong());
        return out;
    }

    /** A line the conversation says about itself (someone joined, the theme changed). {@code payload.event} names it, so every language can say it its own way. */
    private Message say(Access a, String event, String words, ObjectNode payload) {
        payload.put("event", event).put("actor", a.myName());
        UUID ref = UUID.randomUUID();
        if (a.isGroup()) {
            Inserted row = rooms.insertGroup(a.id(), a.me(), "SYSTEM", words, payload, ref, null).orElseThrow();
            Message m = new Message(row.id(), a.id(), a.me(), "SYSTEM", words, payload, ref, row.at(), null, a.myName(), null, null, List.of(), List.of(), false);
            Event e = Event.message(a.id(), m, a.group().title()).quietly();
            for (Reach r : rooms.reach(a.id())) push.send(r.principal(), e);
            return m;
        }
        Side s = a.side();
        boolean online = push.online(s.otherPrincipal());
        Inserted row = repo.insert(a.id(), a.me(), s.other(), "SYSTEM", words, payload, ref, online).orElseThrow();
        Message m = new Message(row.id(), a.id(), a.me(), "SYSTEM", words, payload, ref, row.at(), null, a.myName(), null, null, List.of(), List.of(), false);
        Event e = Event.message(a.id(), m, a.myName()).quietly();
        push.send(s.otherPrincipal(), e);
        push.send(s.myPrincipal(), e);
        return m;
    }

    // ── Typing ──────────────────────────────────────────────
    /** Groups only (two people: {@link MessengerService#typing}). Who is in the group is remembered for half a minute, so a burst of keys costs no query. */
    public void typing(long me, UUID id) {
        Boolean group = kinds.get(id);
        if (group == null) { try { group = access(me, id).isGroup(); } catch (MessengerException e) { return; } }
        if (!group) { direct.typing(me, id); return; }
        long now = System.currentTimeMillis();
        Long last = lastTyping.get(me);
        if (last != null && now - last < 1500) return;
        String key = me + ":" + id;
        Memo memo = typingMemo.get(key);
        if (memo == null || memo.until < now) {
            if (load.busy()) return;
            GroupSide g = rooms.member(me, id).orElse(null);
            if (g == null) return;
            remember(id, true);
            if (typingMemo.size() > 4096) typingMemo.clear();
            memo = new Memo(rooms.reach(id, me), g.myName(), now + 30_000);
            typingMemo.put(key, memo);
        }
        lastTyping.put(me, now);
        if (lastTyping.size() > 8192) lastTyping.clear();
        Event event = Event.typing(id, me, memo.name);
        for (Reach r : memo.reach) if (r.user() != me && !r.quiet()) push.send(r.principal(), event);
    }

    // ── A person's own choices, and the shared theme ────────
    public void settings(long me, UUID id, SettingsRequest request) {
        if (request == null) throw fail(400, "INVALID_REQUEST");
        Access a = access(me, id);
        boolean group = a.isGroup();
        String mute = request.mute() != null ? request.mute() : request.muted() == null ? null : request.muted() ? "FOREVER" : "OFF";
        if (mute != null) {
            Instant until = switch (mute) {
                case "OFF" -> null;
                case "H1" -> Instant.now().plus(Duration.ofHours(1));
                case "H8" -> Instant.now().plus(Duration.ofHours(8));
                case "D1" -> Instant.now().plus(Duration.ofDays(1));
                case "FOREVER" -> MessengerRepository.FOREVER;
                default -> throw fail(400, "INVALID_REQUEST");
            };
            rooms.mute(group, id, me, until);
            // The switch of the first version meant "until I turn it back on": the time now says it.
            if (!group) repo.setMuted(me, id, false);
        }
        if (request.pinned() != null) {
            if (request.pinned() && rooms.pinnedCount(me) >= PINS) throw fail(409, "PIN_LIMIT");
            rooms.pin(group, id, me, request.pinned());
        }
        if (request.archived() != null) rooms.archive(group, id, me, request.archived() ? Math.max(1, a.lastMessage()) : 0);
        if (request.markedUnread() != null) rooms.markUnread(group, id, me, request.markedUnread());
        if (Boolean.TRUE.equals(request.hidden())) { if (group) rooms.hideGroup(id, me); else repo.hide(me, id); }
        if (request.theme() != null) theme(a, request.theme());
        push.send(a.myPrincipal(), Event.people());
    }

    /** The theme belongs to the conversation, like its name: everyone in it sees the same one, and the conversation says who changed it. */
    private void theme(Access a, String theme) {
        if (!THEMES.contains(theme)) throw fail(400, "INVALID_REQUEST");
        if (a.isGroup() ? a.group().restricted() : MessengerService.refused(a.side()) != null || !a.side().connected()) throw fail(403, "NOT_CONNECTED");
        if (theme.equals(a.isGroup() ? a.group().theme() : a.side().theme())) return;
        direct.limit("theme", a.me(), 20, HOUR);
        rooms.setTheme(a.id(), theme);
        say(a, "theme", a.myName() + " đã đổi chủ đề cuộc trò chuyện.", json.createObjectNode().put("theme", theme));
        tell(a, Event.conversation(a.id()));
    }

    // ── Reactions and unsending ─────────────────────────────
    /** The message, if the person asking may see it. */
    private record Seen(Target target, Access access) {}

    private Seen seen(long me, long messageId) {
        Target t = rooms.target(messageId).orElseThrow(() -> fail(404, "MESSAGE_NOT_FOUND"));
        Access a;
        try { a = access(me, t.conversation()); } catch (MessengerException e) { throw fail(404, "MESSAGE_NOT_FOUND"); }
        if (t.id() <= a.floor()) throw fail(404, "MESSAGE_NOT_FOUND");
        return new Seen(t, a);
    }

    /** Emoji only: no letters, no digits, no spaces, a handful of code points (one emoji with its joiners and tone). */
    static String emoji(String raw) {
        if (raw == null) throw fail(400, "INVALID_REQUEST");
        String e = raw.strip();
        int points = e.codePointCount(0, e.length());
        if (e.isEmpty() || e.length() > 32 || points > 12) throw fail(400, "INVALID_REQUEST");
        boolean picture = false;
        for (int i = 0; i < e.length(); ) {
            int c = e.codePointAt(i);
            i += Character.charCount(c);
            if (c == 0x200D || c == 0xFE0F || (c >= 0x1F3FB && c <= 0x1F3FF) || (c >= 0xE0020 && c <= 0xE007F)) continue;
            if (c == 0xA9 || c == 0xAE || (c >= 0x203C && c <= 0x3299) || (c >= 0x1F000 && c <= 0x1FAFF)) { picture = true; continue; }
            throw fail(400, "INVALID_REQUEST");
        }
        if (!picture) throw fail(400, "INVALID_REQUEST");
        return e;
    }

    /** {@code emoji} null: take mine off. One per person per message. */
    public void react(long me, long messageId, String emoji) {
        Seen s = seen(me, messageId);
        Access a = s.access();
        if (s.target().deleted() || "SYSTEM".equals(s.target().kind())) throw fail(409, "MESSAGE_GONE");
        // Reacting is taking part: someone who may not write here may not react here either.
        if (a.isGroup() ? a.group().restricted() : MessengerService.refused(a.side()) != null || !a.side().connected()) throw fail(403, "NOT_CONNECTED");
        direct.limit("react", me, 60, 60_000);
        if (emoji == null) { if (!rooms.unreact(messageId, me)) return; }
        else rooms.react(messageId, me, emoji(emoji));
        tell(a, Event.reaction(a.id(), messageId, me, emoji == null ? null : emoji.strip()));
    }

    public List<ReactionPeople> reactors(long me, long messageId) {
        seen(me, messageId);
        direct.limit("list", me, 120, 60_000);
        Map<String, List<Person>> by = new LinkedHashMap<>();
        for (MessengerRooms.Reactor r : rooms.reactors(messageId)) by.computeIfAbsent(r.emoji(), k -> new ArrayList<>()).add(new Person(r.id(), r.name(), MessengerService.avatarOf(r.id(), r.avatar()), false, null, null));
        return by.entrySet().stream().map(e -> new ReactionPeople(e.getKey(), e.getValue())).toList();
    }

    /** Only the sender, only their own words and files. The row stays so replies and order stay; the words and the files are gone for everyone. */
    public void unsend(long me, long messageId) {
        Seen s = seen(me, messageId);
        if (s.target().sender() != me) throw fail(403, "NOT_YOURS");
        direct.limit("unsend", me, 30, 60_000);
        List<FileRow> gone = tx.execute(status -> rooms.unsend(messageId, me) ? rooms.removeOf(messageId) : null);
        if (gone == null) throw fail(409, "MESSAGE_GONE");
        for (FileRow f : gone) { files.delete(f.key()); files.delete(f.thumbKey()); }
        tell(s.access(), Event.unsent(s.access().id(), messageId, me));
    }

    // ── Attachments ─────────────────────────────────────────
    private void mayShare(Access a) {
        if (a.isGroup()) { if (a.group().restricted()) throw fail(403, "RESTRICTED"); }
        else direct.mustBeConnected(a.side());
    }

    /** Files that waited in a composer for an hour are removed, by whoever uploads next: no thread of its own, at most once in ten minutes. */
    private void sweep() {
        long now = System.currentTimeMillis();
        if (now - sweptAt < 600_000) return;
        sweptAt = now;
        try { for (FileRow f : rooms.abandon(100)) { files.delete(f.key()); files.delete(f.thumbKey()); } }
        catch (RuntimeException e) { log.warn("[Messenger] sweep failed: {}", e.getClass().getSimpleName()); }
    }

    /**
     * One file for the composer of this conversation: checked, stored, and waiting until a message carries it. The person must be allowed to write here; what they keep
     * on the server and what they added this month are bounded; the picture's small preview comes from their own browser and is checked like any picture.
     */
    public Attachment upload(long me, UUID id, MultipartFile file, MultipartFile thumb, String name) {
        Access a = access(me, id);
        mayShare(a);
        direct.limit("upload", me, 40, 600_000);
        if (file == null || file.isEmpty()) throw fail(400, "ATTACHMENT_EMPTY");
        if (file.getSize() > MessengerFiles.FILE_MAX) throw fail(413, "ATTACHMENT_TOO_LARGE");
        MessengerRooms.Usage used = rooms.usage(me);
        if (used.waiting() >= MessengerFiles.WAITING_MAX) throw fail(429, "ATTACHMENT_WAITING");
        if (used.live() + file.getSize() > MessengerFiles.LIVE_QUOTA || used.month() + file.getSize() > MessengerFiles.MONTH_QUOTA) throw fail(413, "ATTACHMENT_QUOTA");
        sweep();
        UUID fileId = UUID.randomUUID();
        String label = MessengerFiles.label(name != null && !name.isBlank() ? name : file.getOriginalFilename());
        MessengerFiles.Stored kept = files.store(fileId, file, label);
        String thumbKey = null;
        try {
            if ("IMAGE".equals(kept.kind())) {
                MessengerFiles.Stored small = files.storeSmall(kept.key() + ".t", thumb, MessengerFiles.THUMB_MAX);
                thumbKey = small == null ? null : small.key();
            }
            rooms.insertFile(new FileRow(fileId, me, id, null, kept.kind(), label, kept.mime(), kept.size(), kept.width(), kept.height(), kept.key(), thumbKey));
        } catch (RuntimeException e) {
            files.delete(kept.key());
            files.delete(thumbKey);
            throw e;
        }
        return new Attachment(fileId, kept.kind(), label, kept.mime(), kept.size(), kept.width(), kept.height(), thumbKey != null);
    }

    /** Taken back from the composer before sending. */
    public void discard(long me, UUID fileId) {
        rooms.discard(fileId, me).ifPresent(f -> { files.delete(f.key()); files.delete(f.thumbKey()); });
    }

    public record Download(Path path, String mime, String name, boolean picture) {}

    /** The bytes, for the people of the conversation only; while a file waits in a composer, for its owner only. Anyone else: not found. */
    public Download download(long me, UUID fileId, boolean thumb) {
        FileRow f = rooms.file(fileId).orElseThrow(() -> fail(404, "ATTACHMENT_NOT_FOUND"));
        if (f.message() == null) { if (f.owner() != me) throw fail(404, "ATTACHMENT_NOT_FOUND"); }
        else {
            Access a;
            try { a = access(me, f.conversation()); } catch (MessengerException e) { throw fail(404, "ATTACHMENT_NOT_FOUND"); }
            if (f.message() <= a.floor()) throw fail(404, "ATTACHMENT_NOT_FOUND");
        }
        boolean picture = "IMAGE".equals(f.kind());
        if (thumb) {
            if (!picture || f.thumbKey() == null) throw fail(404, "ATTACHMENT_NOT_FOUND");
            Path p = files.open(f.thumbKey());
            return new Download(p, files.pictureType(p), f.name(), true);
        }
        return new Download(files.open(f.key()), f.mime(), f.name(), picture);
    }

    public List<Attachment> shared(long me, UUID id, String kind) {
        Access a = access(me, id);
        direct.limit("list", me, 120, 60_000);
        return rooms.shared(id, a.floor(), "FILE".equals(kind) ? "FILE" : "IMAGE", 60);
    }

    // ── Groups ──────────────────────────────────────────────
    private static String title(String raw) {
        if (raw == null) throw fail(400, "GROUP_TITLE_INVALID");
        StringBuilder b = new StringBuilder();
        raw.codePoints().filter(c -> !Character.isISOControl(c)).forEach(b::appendCodePoint);
        String t = b.toString().strip().replaceAll("\\s+", " ");
        if (t.isEmpty() || t.length() > TITLE_MAX) throw fail(400, "GROUP_TITLE_INVALID");
        return t;
    }

    private Conversation groupView(long me, UUID id) {
        return rooms.groups(me, null, 1, null, id).stream().findFirst().map(direct::view).orElseThrow(() -> fail(404, "CONVERSATION_NOT_FOUND"));
    }

    private List<Long> wanted(long me, List<Long> ids) {
        if (ids == null) throw fail(400, "INVALID_REQUEST");
        Set<Long> set = new LinkedHashSet<>();
        for (Long id : ids) if (id != null && id != me) set.add(id);
        if (set.isEmpty() || set.size() > GROUP_SIZE) throw fail(400, "INVALID_REQUEST");
        return List.copyOf(set);
    }

    private String names(List<Long> ids) {
        List<String> out = new ArrayList<>();
        for (long id : ids.subList(0, Math.min(3, ids.size()))) out.add(repo.personById(id).map(MessengerRepository.PersonRow::name).orElse("một bạn"));
        return String.join(", ", out) + (ids.size() > 3 ? " và " + (ids.size() - 3) + " người khác" : "");
    }

    /** A group starts with its maker and friends of theirs: nobody is put in a group by a stranger, or across a block. */
    public Conversation createGroup(long me, GroupRequest request) {
        if (request == null) throw fail(400, "INVALID_REQUEST");
        String name = title(request.title());
        List<Long> others = wanted(me, request.members());
        if (others.size() > GROUP_SIZE - 1) throw fail(409, "GROUP_FULL");
        direct.limit("group", me, 5, HOUR);
        if (rooms.groupsOf(me) >= GROUPS_PER_PERSON) throw fail(409, "GROUP_LIMIT");
        if (rooms.addable(me, others).size() != others.size()) throw fail(403, "GROUP_MEMBER_NOT_ALLOWED");
        UUID id = UUID.randomUUID();
        tx.executeWithoutResult(status -> rooms.createGroup(id, me, name, others));
        remember(id, true);
        Access a = access(me, id);
        say(a, "created", a.myName() + " đã tạo nhóm.", json.createObjectNode().put("title", name));
        tell(a, Event.conversation(id));
        return groupView(me, id);
    }

    public GroupDetail group(long me, UUID id) {
        Access a = access(me, id);
        if (!a.isGroup()) throw fail(404, "CONVERSATION_NOT_FOUND");
        direct.limit("list", me, 120, 60_000);
        List<Member> members = rooms.members(me, id).stream().map(m -> new Member(direct.person(m.person(), "FRIEND".equals(m.person().relation())), m.role(), m.joined())).toList();
        return new GroupDetail(groupView(me, id), members, GROUP_SIZE);
    }

    private Access managed(long me, UUID id) {
        Access a = access(me, id);
        if (!a.isGroup()) throw fail(404, "CONVERSATION_NOT_FOUND");
        if (!a.group().manages()) throw fail(403, "NOT_ALLOWED");
        return a;
    }

    public Conversation rename(long me, UUID id, GroupUpdate request) {
        Access a = managed(me, id);
        String name = title(request == null ? null : request.title());
        if (!name.equals(a.group().title())) {
            direct.limit("groupedit", me, 20, HOUR);
            rooms.rename(id, name);
            say(a, "renamed", a.myName() + " đã đổi tên nhóm thành " + name + ".", json.createObjectNode().put("title", name));
            tell(a, Event.conversation(id));
        }
        return groupView(me, id);
    }

    public Conversation setAvatar(long me, UUID id, MultipartFile picture) {
        Access a = managed(me, id);
        direct.limit("groupedit", me, 20, HOUR);
        Optional<String> old = rooms.avatarKey(id);
        String key = "g/" + id + "-" + UUID.randomUUID().toString().substring(0, 8);
        if (files.storeSmall(key, picture, MessengerFiles.AVATAR_MAX) == null) throw fail(400, "ATTACHMENT_EMPTY");
        rooms.setAvatar(id, key);
        old.ifPresent(files::delete);
        say(a, "avatar", a.myName() + " đã đổi ảnh nhóm.", json.createObjectNode());
        tell(a, Event.conversation(id));
        return groupView(me, id);
    }

    public Download avatar(long me, UUID id) {
        Access a = access(me, id);
        if (!a.isGroup()) throw fail(404, "CONVERSATION_NOT_FOUND");
        Path p = files.open(rooms.avatarKey(id).orElseThrow(() -> fail(404, "ATTACHMENT_NOT_FOUND")));
        return new Download(p, files.pictureType(p), "group", true);
    }

    /** Only group managers (OWNER or ADMIN) may add their own friends. Someone who comes (or comes back) reads from now on. */
    public GroupDetail addMembers(long me, UUID id, MembersRequest request) {
        Access a = managed(me, id);
        if (a.group().restricted()) throw fail(403, "RESTRICTED");
        List<Long> others = wanted(me, request == null ? null : request.members());
        direct.limit("groupadd", me, 30, HOUR);
        if (rooms.addable(me, others).size() != others.size()) throw fail(403, "GROUP_MEMBER_NOT_ALLOWED");
        List<Long> added = tx.execute(status -> {
            List<Long> in = new ArrayList<>();
            for (long other : others) if (rooms.addMember(id, other, me)) in.add(other);
            if (rooms.memberCount(id) > GROUP_SIZE) throw fail(409, "GROUP_FULL");
            return in;
        });
        if (added != null && !added.isEmpty()) {
            typingMemo.clear();
            ObjectNode payload = json.createObjectNode();
            payload.put("names", names(added));
            say(a, "added", a.myName() + " đã thêm " + names(added) + " vào nhóm.", payload);
            tell(a, Event.conversation(id));
        }
        return group(me, id);
    }

    /** Leaving: the group goes from my list and I no longer read it. An owner who leaves hands the group to an admin, or to whoever has been there longest. */
    public void leave(long me, UUID id) {
        Access a = access(me, id);
        if (!a.isGroup()) throw fail(404, "CONVERSATION_NOT_FOUND");
        say(a, "left", a.myName() + " đã rời nhóm.", json.createObjectNode());
        tx.executeWithoutResult(status -> {
            rooms.leave(id, me);
            if ("OWNER".equals(a.group().role())) rooms.heir(id).ifPresent(next -> rooms.setRole(id, next, "OWNER"));
        });
        typingMemo.clear();
        push.send(a.myPrincipal(), Event.removed(id));
        for (Reach r : rooms.reach(id)) push.send(r.principal(), Event.conversation(id));
    }

    /** The owner removes anyone; an admin removes members. Nobody removes the owner. */
    public GroupDetail remove(long me, UUID id, long other) {
        Access a = managed(me, id);
        if (other == me) throw fail(400, "INVALID_REQUEST");
        String role = rooms.roleOf(id, other).orElseThrow(() -> fail(404, "USER_NOT_FOUND"));
        if ("OWNER".equals(role) || ("ADMIN".equals(role) && !"OWNER".equals(a.group().role()))) throw fail(403, "NOT_ALLOWED");
        direct.limit("groupedit", me, 40, HOUR);
        String name = names(List.of(other));
        if (!rooms.leave(id, other)) throw fail(404, "USER_NOT_FOUND");
        typingMemo.clear();
        ObjectNode payload = json.createObjectNode();
        payload.put("names", name);
        say(a, "removed", a.myName() + " đã mời " + name + " ra khỏi nhóm.", payload);
        repo.personById(other).ifPresent(p -> push.send(p.principal(), Event.removed(id)));
        tell(a, Event.conversation(id));
        return group(me, id);
    }

    /** Only the owner names admins, and only the owner hands the group over (then stays as an admin). */
    public GroupDetail role(long me, UUID id, long other, RoleRequest request) {
        Access a = access(me, id);
        if (!a.isGroup()) throw fail(404, "CONVERSATION_NOT_FOUND");
        if (!"OWNER".equals(a.group().role()) || other == me) throw fail(403, "NOT_ALLOWED");
        String role = request == null ? null : request.role();
        if (role == null || !Set.of("OWNER", "ADMIN", "MEMBER").contains(role)) throw fail(400, "INVALID_REQUEST");
        direct.limit("groupedit", me, 40, HOUR);
        tx.executeWithoutResult(status -> {
            if (!rooms.setRole(id, other, role)) throw fail(404, "USER_NOT_FOUND");
            if ("OWNER".equals(role)) rooms.setRole(id, me, "ADMIN");
        });
        ObjectNode payload = json.createObjectNode();
        payload.put("names", names(List.of(other))).put("role", role);
        say(a, "role", a.myName() + " đã đổi vai trò của " + names(List.of(other)) + ".", payload);
        tell(a, Event.conversation(id));
        return group(me, id);
    }
}
