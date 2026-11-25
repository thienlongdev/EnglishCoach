package com.englishcoach.messenger;

import com.englishcoach.community.dto.CommunityUserProfileDto;
import com.englishcoach.community.service.CommunityInteractionService;
import com.englishcoach.messenger.MessengerDtos.*;
import com.englishcoach.messenger.MessengerRepository.*;
import com.englishcoach.messenger.MessengerRooms.FileRow;
import com.englishcoach.messenger.MessengerRooms.GroupRow;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Echo Messenger. A friend is someone who follows you back in Community: there is no second friendship table. Someone who is not a friend may write a few messages that wait
 * in the other person's Requests, if that person allows it. Conversations and messages are the database's; what moves in real time only moves on the private STOMP queue every
 * signed-in page already has, and only to someone online. A message's text is never written to a log.
 *
 * It shares one small server with learning: everything a page does while nobody is using the Messenger is one statement, limits are per person and in memory, and the
 * courtesies (typing, presence, delivery marks) stand aside when the database is busy.
 */
@Service
public class MessengerService {
    private static final Logger log = LoggerFactory.getLogger(MessengerService.class);
    static final int BODY_LIMIT = 2000;
    static final int REQUEST_MESSAGES = 3;
    static final int CONVERSATIONS_PAGE = 30;
    static final int FRIENDS_PAGE = 100;
    static final int SEARCH_PAGE = 20;
    static final Duration INVITE_LIFE = Duration.ofMinutes(3);
    private static final long HOUR = 3_600_000, DAY = 24 * HOUR;
    private static final ZoneId LOCAL = ZoneId.of("Asia/Ho_Chi_Minh");
    private static final Set<String> MODES = Set.of("FREE", "GUIDED", "DUEL", "TEAM");
    private static final Pattern USERNAME = Pattern.compile("^[a-z0-9][a-z0-9_.]{2,23}$");

    static final Duration SEEN_FOR = Duration.ofDays(7);
    private final MessengerRepository repo;
    private final MessengerRooms rooms;
    private final MessengerFiles files;
    private final MessengerPush push;
    private final ArenaInvites arena;
    private final NotificationService notifications;
    private final CommunityInteractionService community;
    private final TransactionTemplate tx;
    private final MessengerLoad load;
    private final ObjectMapper json = new ObjectMapper();
    private record Window(long start, int count) {}
    private final Map<String, Window> windows = new ConcurrentHashMap<>();
    private record Memo(Side side, long until) {}
    private final Map<String, Memo> typingMemo = new ConcurrentHashMap<>();
    private final Map<Long, Long> lastTyping = new ConcurrentHashMap<>();
    private final Map<String, Long> declined = new ConcurrentHashMap<>();
    /** The bell keeps one reminder per key anyway: remembering it here saves the database a question per message to someone away. */
    private final Set<String> reminded = ConcurrentHashMap.newKeySet();

    public MessengerService(MessengerRepository repo, MessengerRooms rooms, MessengerFiles files, MessengerPush push, ArenaInvites arena, NotificationService notifications, CommunityInteractionService community, TransactionTemplate tx, MessengerLoad load) {
        this.repo = repo;
        this.rooms = rooms;
        this.files = files;
        this.push = push;
        this.arena = arena;
        this.notifications = notifications;
        this.community = community;
        this.tx = tx;
        this.load = load;
    }

    static MessengerException fail(int status, String code) { return new MessengerException(status, code); }

    /** In memory: one backend, and a limit that resets on a restart costs nothing here. */
    void limit(String kind, long user, int most, long windowMs) {
        long now = System.currentTimeMillis();
        Window w = windows.compute(kind + user, (k, old) -> old == null || now - old.start > windowMs ? new Window(now, 1) : new Window(old.start, old.count + 1));
        if (w.count > most) throw fail(429, "RATE_LIMIT");
        if (windows.size() > 8192) windows.entrySet().removeIf(e -> now - e.getValue().start > 2 * HOUR);
    }

    static String avatarOf(long id, boolean has) { return has ? "/api/v1/users/" + id + "/avatar" : null; }

    /**
     * Activity is one answer for the whole product: online while any page of the person holds its socket, otherwise when their last page closed, for seven days,
     * then nothing. {@code allowed}: the person asking may see it at all (connected, neither hides their own, no block, not restricted by them).
     */
    private Person person(long id, String name, boolean avatar, String principal, String username, String relation, boolean allowed, Instant lastSeen) {
        boolean online = allowed && push.online(principal);
        Instant last = allowed && !online && lastSeen != null && lastSeen.isAfter(Instant.now().minus(SEEN_FOR)) ? lastSeen : null;
        return new Person(id, name, avatarOf(id, avatar), online, username, relation, last);
    }
    Person person(PersonRow row, boolean showOnline) {
        return person(row.id(), row.name(), row.avatar(), row.principal(), row.username(), row.relation(), showOnline && row.seesActivity(), row.lastSeen());
    }
    Person person(Side side) {
        return person(side.other(), side.otherName(), side.otherAvatar(), side.otherPrincipal(), side.otherUsername(), side.friends() ? "FRIEND" : null,
                side.connected() && side.seesActivity() && !side.iBlocked() && !side.theyBlocked(), side.otherLastSeen());
    }

    // ── People ──────────────────────────────────────────────
    public People people(long me) { return people(me, 0); }

    public People people(long me, int offset) {
        limit("list", me, 120, 60_000);
        PeopleRows rows = repo.people(me, FRIENDS_PAGE, Math.max(0, offset));
        return new People(rows.friends().stream().map(r -> person(r, true)).toList(), rows.incoming().stream().map(r -> person(r, false)).toList(),
                rows.outgoing().stream().map(r -> person(r, false)).toList(), rows.blocked().stream().map(r -> person(r, false)).toList(), rows.moreFriends(),
                rows.restricted().stream().map(r -> person(r, false)).toList(), Instant.now());
    }

    /** "@minh" looks at usernames only; plain words look at the words of a name and at usernames that begin with them. */
    public PersonPage search(long me, String query, String after) {
        String raw = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (raw.isEmpty() || raw.length() > 60) return new PersonPage(List.of(), null);
        boolean handle = raw.startsWith("@");
        String text = handle ? raw.substring(1) : raw;
        String username = text.replaceAll("[^a-z0-9_.]", "");
        List<String> words = new ArrayList<>();
        if (!handle) for (String w : MessengerNames.fold(text).split(" ")) if (w.length() >= 2 && words.size() < 5) words.add(w.substring(0, Math.min(w.length(), 12)));
        boolean usable = username.length() >= 2 && (handle || !text.contains(" "));
        if (words.isEmpty() && !usable) return new PersonPage(List.of(), null);
        limit("search", me, 30, 60_000);
        List<PersonRow> rows = repo.search(me, words, usable ? username : null, usable ? username : null, after, SEARCH_PAGE + 1);
        boolean more = rows.size() > SEARCH_PAGE;
        List<PersonRow> page = more ? rows.subList(0, SEARCH_PAGE) : rows;
        return new PersonPage(page.stream().map(r -> person(r, false)).toList(), more ? page.get(page.size() - 1).username() : null);
    }

    public Profile profile(long me, long other) {
        limit("profile", me, 60, 60_000);
        Relation r = repo.relation(me, other).orElseThrow(() -> fail(404, "USER_NOT_FOUND"));
        if (r.theyBlockedMe()) throw fail(404, "USER_NOT_FOUND");
        CommunityUserProfileDto stats = community.getUserProfile(me, other);
        boolean self = me == other, connected = r.friends() || "ACCEPTED".equals(r.requestState());
        String refused = self ? null : r.iBlocked() ? "BLOCKED_BY_ME" : connected ? null : r.requestState() != null && "PENDING".equals(r.requestState()) && r.requestBy() != null && r.requestBy() != me ? "REQUEST_TO_ANSWER"
                : "DECLINED".equals(r.requestState()) && r.requestBy() != null && r.requestBy() == me ? "UNAVAILABLE" : "FRIENDS".equals(r.policy()) ? "FRIENDS_ONLY" : null;
        Person shown = person(r.person().id(), r.person().name(), r.person().avatar(), r.person().principal(), r.person().username(), self ? "SELF" : r.person().relation(),
                !self && connected && !r.iBlocked() && r.person().seesActivity(), r.person().lastSeen());
        return new Profile(shown, self, refused, connected, r.conversation(), stats == null ? 0 : stats.getFollowerCount(), stats == null ? 0 : stats.getFollowingCount(), stats == null ? 0 : stats.getStreakDays(), stats == null ? null : stats.getCefrLevel(), stats != null && stats.isPremium(), r.iRestricted());
    }

    public Me me(long me) {
        MeRow row = repo.me(me).orElseThrow(() -> fail(404, "USER_NOT_FOUND"));
        return new Me(row.username(), row.policy(), row.discoverable(), row.showActivity());
    }

    public Me updateMe(long me, MeRequest request) {
        if (request == null) throw fail(400, "INVALID_REQUEST");
        limit("me", me, 20, HOUR);
        String username = request.username() == null ? null : request.username().trim().toLowerCase(Locale.ROOT).replaceFirst("^@", "");
        if (username != null && !USERNAME.matcher(username).matches()) throw fail(400, "USERNAME_INVALID");
        String policy = request.messagePolicy();
        if (policy != null && !Set.of("EVERYONE", "FRIENDS").contains(policy)) throw fail(400, "INVALID_REQUEST");
        // Hiding my activity is told to those who were seeing it, before they can no longer be found.
        List<String> watching = Boolean.FALSE.equals(request.showActivity()) ? repo.friendPrincipals(me) : List.of();
        if (!repo.updateMe(me, username, policy, request.discoverable(), request.showActivity())) throw fail(409, "USERNAME_TAKEN");
        for (String friend : watching) push.send(friend, Event.presence(me, false, null));
        if (Boolean.TRUE.equals(request.showActivity())) for (String friend : repo.friendPrincipals(me)) push.send(friend, Event.presence(me, true, null));
        return me(me);
    }

    private String nameOf(long id) { return repo.personById(id).map(PersonRow::name).orElse("Một bạn"); }

    /** Asking, or answering what they asked: the same button, and the same Community follow. */
    public void addFriend(long me, long other) {
        if (me == other) throw fail(400, "INVALID_REQUEST");
        PersonRow them = repo.personById(other).orElseThrow(() -> fail(404, "USER_NOT_FOUND"));
        if (repo.blockedEitherWay(me, other)) throw fail(403, "UNAVAILABLE");
        if (repo.follows(me, other)) return;
        boolean answering = repo.follows(other, me);
        if (!answering) {
            Long when = declined.get(me + ":" + other);
            if (when != null && System.currentTimeMillis() - when < DAY) throw fail(409, "REQUEST_DECLINED");
            limit("friend", me, 20, HOUR);
        }
        community.followUser(me, other, false);
        String name = nameOf(me);
        if (answering) {
            repo.settleRequest(me, other);
            push.send(them.principal(), Event.friendAccepted(me, name));
            remindPerson(other, name + " đã đồng ý kết bạn.", "/community/messages?view=friends", "messenger_friend_yes_" + Math.min(me, other) + "_" + Math.max(me, other));
        } else {
            push.send(them.principal(), Event.friendRequest(me, name));
            remindPerson(other, name + " đã gửi lời mời kết bạn.", "/community/messages?view=requests", "messenger_friend_ask_" + me + "_" + other);
        }
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    /** Friends: both stop following, as on any social site. A request of mine: taken back. */
    public void removeFriend(long me, long other) {
        boolean theyFollow = repo.follows(other, me), iFollow = repo.follows(me, other);
        if (iFollow) community.unfollowUser(me, other);
        if (iFollow && theyFollow) { community.unfollowUser(other, me); repo.resetRequest(me, other); }
        typingMemo.clear();
        repo.personById(other).ifPresent(them -> push.send(them.principal(), Event.people()));
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    /** No to someone's request: their follow ends, they are not told, and they cannot simply ask again today. */
    public void declineFriend(long me, long other) {
        if (repo.follows(me, other)) throw fail(409, "ALREADY_FRIENDS");
        community.unfollowUser(other, me);
        long now = System.currentTimeMillis();
        declined.put(other + ":" + me, now);
        if (declined.size() > 8192) declined.entrySet().removeIf(e -> now - e.getValue() > DAY);
        repo.personById(other).ifPresent(them -> push.send(them.principal(), Event.people()));
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    public boolean isDeclinedCooldownActive(long requesterId, long targetId) {
        Long when = declined.get(requesterId + ":" + targetId);
        return when != null && System.currentTimeMillis() - when < DAY;
    }

    public void block(long me, long other) {
        if (me == other) throw fail(400, "INVALID_REQUEST");
        repo.block(me, other);
        repo.declinePending(me, other);
        repo.relation(me, other).map(Relation::conversation).ifPresent(convId ->
                repo.pendingIn(convId).ifPresent(inv -> {
                    if (repo.respond(inv.id(), "CANCELLED", null)) {
                        repo.personById(me).ifPresent(self ->
                                push.send(self.principal(), Event.invite(inv.conversation(), view(inv, "CANCELLED", null), self.name())));
                    }
                })
        );
        typingMemo.clear();
        repo.personById(other).ifPresent(them -> push.send(them.principal(), Event.people()));
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    public void unblock(long me, long other) {
        repo.unblock(me, other);
        typingMemo.clear();
        repo.personById(other).ifPresent(them -> push.send(them.principal(), Event.people()));
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    /**
     * Quieter than blocking, and the other person is not told. Their conversation waits aside (no card, no bell, no number on the badge), they no longer see what I have
     * read or whether I am here. They can still write, and I can read and answer whenever I choose.
     */
    public void restrict(long me, long other) {
        if (me == other) throw fail(400, "INVALID_REQUEST");
        PersonRow them = repo.personById(other).orElseThrow(() -> fail(404, "USER_NOT_FOUND"));
        rooms.restrict(me, other);
        typingMemo.clear();
        push.send(them.principal(), Event.presence(me, false, null));
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    public void unrestrict(long me, long other) {
        rooms.unrestrict(me, other);
        typingMemo.clear();
        repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
    }

    /** Someone followed or stopped following in Community: the same relation, seen from here. */
    public void followChanged(long me, long other) {
        try {
            if (repo.follows(me, other) && repo.follows(other, me)) repo.settleRequest(me, other);
            repo.personById(other).ifPresent(them -> push.send(them.principal(), Event.people()));
            repo.personById(me).ifPresent(self -> push.send(self.principal(), Event.people()));
        } catch (RuntimeException e) {
            log.warn("[Messenger] follow not told: {}", e.getClass().getSimpleName());
        }
    }

    // ── Conversations ───────────────────────────────────────
    /** Null: a message may go. */
    private static String refused(long me, boolean friends, boolean iBlocked, boolean theyBlocked, boolean restricted, boolean active, String state, Long by, String policy) {
        if (restricted) return "RESTRICTED";
        if (iBlocked) return "BLOCKED_BY_ME";
        if (theyBlocked || !active) return "UNAVAILABLE";
        if (friends || "ACCEPTED".equals(state)) return null;
        if ("PENDING".equals(state)) return by != null && by == me ? null : "REQUEST_TO_ANSWER";
        if ("DECLINED".equals(state) && by != null && by == me) return "UNAVAILABLE";
        return "FRIENDS".equals(policy) ? "FRIENDS_ONLY" : null;
    }
    static String refused(Side s) { return refused(s.me(), s.friends(), s.iBlocked(), s.theyBlocked(), s.restricted(), s.otherActive(), s.requestState(), s.requestBy(), s.otherPolicy()); }
    private static String requestOf(long me, boolean connected, String state, Long by) {
        if (connected || !"PENDING".equals(state) || by == null) return null;
        return by == me ? "MINE" : "THEIRS";
    }

    public Conversation open(long me, long other) {
        if (me == other) throw fail(400, "INVALID_REQUEST");
        limit("open", me, 60, 60_000);
        Relation r = repo.relation(me, other).orElseThrow(() -> fail(404, "USER_NOT_FOUND"));
        if (r.theyBlockedMe()) throw fail(403, "UNAVAILABLE");
        boolean connected = r.friends() || "ACCEPTED".equals(r.requestState());
        if (!connected && !r.iBlocked() && "FRIENDS".equals(r.policy())) throw fail(403, "FRIENDS_ONLY");
        UUID id = r.conversation() != null ? r.conversation() : repo.openConversation(me, other);
        Side side = side(me, id);
        Markers m = repo.markers(me, id);
        long theirDelivered = side.restrictsMe() ? 0 : m.theirDelivered();
        return new Conversation(id, person(side), null, 0, m.myRead(), m.theirRead(), theirDelivered, false, refused(side), side.connected(), requestOf(me, side.connected(), side.requestState(), side.requestBy()),
                "DIRECT", null, null, 2, null, side.theme(), false, false, null, side.iRestricted(), false);
    }

    private Invite live(Invite invite) {
        if (invite != null && "ACCEPTED".equals(invite.status()) && invite.code() != null && !arena.isOpen(invite.code())) return invite.closed();
        return invite;
    }
    Message live(Message m) { return m == null || m.invite() == null ? m : m.with(live(m.invite())); }

    Conversation view(long me, ConversationRow r) {
        boolean connected = r.friends() || "ACCEPTED".equals(r.requestState());
        PersonRow o = r.other();
        Person other = person(o.id(), o.name(), o.avatar(), o.principal(), o.username(), r.friends() ? "FRIEND" : null, connected && o.seesActivity() && !r.iBlocked() && !r.theyBlocked(), o.lastSeen());
        return new Conversation(r.id(), other, live(r.last()), r.unread(), r.myRead(), r.theirRead(), r.theirDelivered(), r.muted(),
                refused(me, r.friends(), r.iBlocked(), r.theyBlocked(), r.restricted(), true, r.requestState(), r.requestBy(), r.otherPolicy()), connected, requestOf(me, connected, r.requestState(), r.requestBy()),
                "DIRECT", null, null, 2, null, r.theme(), r.pinned(), r.archived(), r.mutedUntil(), r.iRestricted(), r.markedUnread());
    }

    static String groupAvatar(UUID id, boolean has, int version) { return has ? "/api/v1/messenger/groups/" + id + "/avatar?v=" + version : null; }

    Conversation view(GroupRow g) {
        return new Conversation(g.id(), null, g.last(), g.unread(), g.readId(), 0, 0, g.mutedUntil() != null, null, true, null,
                "GROUP", g.title(), groupAvatar(g.id(), g.avatar(), g.avatarVersion()), g.members(), g.role(), g.theme(), g.pinned(), g.archived(), g.mutedUntil(), false, g.markedUnread());
    }

    public List<Conversation> conversations(long me) { return conversationPage(me, null, "MAIN").items(); }

    public ConversationPage conversationPage(long me, Instant before) { return conversationPage(me, before, "MAIN"); }

    /**
     * One list of one-to-one conversations and groups, newest first, pinned ones first on the first page. {@code scope}: MAIN, ARCHIVED, or RESTRICTED (people I restricted).
     * Two statements (one per kind), merged here; both use the same keyset.
     */
    public ConversationPage conversationPage(long me, Instant before, String scope) {
        limit("list", me, 120, 60_000);
        String where = "ARCHIVED".equals(scope) || "RESTRICTED".equals(scope) ? scope : "MAIN";
        // Opening the first page is when what waited for this person has reached them.
        if (before == null && "MAIN".equals(where) && !load.busy()) {
            for (NewlyDelivered d : repo.markAllDelivered(me)) {
                if (!rooms.restricts(me, d.sender()) && !repo.blockedEitherWay(me, d.sender())) {
                    push.send(d.senderPrincipal(), Event.delivered(d.conversation(), me, d.upTo()));
                }
            }
        }
        List<ConversationRow> rows = repo.conversations(me, before, CONVERSATIONS_PAGE + 1, where);
        List<GroupRow> groups = "RESTRICTED".equals(where) ? List.of() : rooms.groups(me, before, CONVERSATIONS_PAGE + 1, where, null);
        record Line(boolean pinned, Instant at, Conversation c) {}
        List<Line> lines = new ArrayList<>();
        for (ConversationRow r : rows) lines.add(new Line(r.pinned(), r.at(), view(me, r)));
        for (GroupRow g : groups) lines.add(new Line(g.pinned(), g.at(), view(g)));
        lines.sort((a, b) -> a.pinned() != b.pinned() ? (a.pinned() ? -1 : 1) : (b.at() == null ? Instant.EPOCH : b.at()).compareTo(a.at() == null ? Instant.EPOCH : a.at()));
        boolean more = lines.size() > CONVERSATIONS_PAGE;
        return new ConversationPage((more ? lines.subList(0, CONVERSATIONS_PAGE) : lines).stream().map(Line::c).toList(), more, Instant.now());
    }

    public List<Conversation> requests(long me) {
        limit("list", me, 120, 60_000);
        List<Conversation> out = new ArrayList<>();
        for (ConversationRow r : repo.requests(me, 60)) out.add(view(me, r));
        return out;
    }

    public Summary summary(long me) {
        limit("list", me, 120, 60_000);
        SummaryRow s = repo.summary(me);
        return new Summary(s.unread(), s.messageRequests(), s.friendRequests());
    }

    public void acceptRequest(long me, UUID id) {
        Side side = side(me, id);
        if (!repo.answerRequest(id, me, "ACCEPTED")) throw fail(409, "REQUEST_CLOSED");
        push.send(side.otherPrincipal(), Event.requestAccepted(id, me, side.myName()));
        push.send(side.myPrincipal(), Event.people());
    }

    /** The person who wrote is not told; they learn it is unavailable if they write again. */
    public void declineRequest(long me, UUID id) {
        Side side = side(me, id);
        if (!repo.answerRequest(id, me, "DECLINED")) throw fail(409, "REQUEST_CLOSED");
        push.send(side.myPrincipal(), Event.people());
    }

    Side side(long me, UUID id) { return repo.side(me, id).orElseThrow(() -> fail(404, "CONVERSATION_NOT_FOUND")); }

    public MessagePage messages(long me, UUID id, Long before, String query) { return messages(me, side(me, id), before, query, 0); }

    /** {@code downTo}: reach back as far as this message (the one a reply answers), within a bound: a reply to something very old says so instead of loading a book. */
    MessagePage messages(long me, Side side, Long before, String query, long downTo) {
        int size = downTo > 0 ? 240 : 40;
        List<Message> rows = repo.messages(me, side.id(), before == null ? 0 : before, side.myHidden(), size + 1, query == null ? null : query.trim(), downTo);
        boolean more = rows.size() > size;
        List<Message> page = new ArrayList<>(more ? rows.subList(0, size) : rows);
        java.util.Collections.reverse(page);
        page.replaceAll(this::live);
        Markers m = repo.markers(me, side.id());
        long theirDelivered = side.restrictsMe() ? 0 : m.theirDelivered();
        return new MessagePage(page, more || (downTo > 0 && downTo > side.myHidden() + 1), m.myRead(), m.theirRead(), theirDelivered);
    }

    void mustSend(Side side) {
        String why = refused(side);
        if (why != null) throw fail(403, why);
    }

    /** What is more than a few words needs the other person's yes first. */
    void mustBeConnected(Side side) {
        mustSend(side);
        if (!side.connected()) throw fail(403, "NOT_CONNECTED");
    }

    /** {@code mayBeEmpty}: a message that carries files needs no words. */
    static String clean(String body, boolean mayBeEmpty) {
        if (body == null) { if (mayBeEmpty) return ""; throw fail(400, "MESSAGE_EMPTY"); }
        StringBuilder b = new StringBuilder(body.length());
        body.codePoints().filter(c -> c == '\n' || c == '\t' || !Character.isISOControl(c)).forEach(b::appendCodePoint);
        String text = b.toString().strip();
        if (text.isEmpty() && !mayBeEmpty) throw fail(400, "MESSAGE_EMPTY");
        if (text.length() > BODY_LIMIT) throw fail(413, "MESSAGE_TOO_LONG");
        return text;
    }

    /** The files a message carries, checked against what one message may hold. Only files this person uploaded for this conversation and has not sent yet. */
    List<FileRow> filesFor(long me, UUID conversation, List<UUID> ids) {
        if (ids == null || ids.isEmpty()) return List.of();
        List<UUID> wanted = ids.stream().filter(java.util.Objects::nonNull).distinct().toList();
        if (wanted.size() > MessengerFiles.IMAGES_PER_MESSAGE + MessengerFiles.FILES_PER_MESSAGE) throw fail(413, "ATTACHMENT_TOO_MANY");
        List<FileRow> found = rooms.pending(me, conversation, wanted);
        if (found.size() != wanted.size()) throw fail(409, "ATTACHMENT_GONE");
        long images = found.stream().filter(f -> "IMAGE".equals(f.kind())).count(), total = found.stream().mapToLong(FileRow::size).sum();
        if (images > MessengerFiles.IMAGES_PER_MESSAGE || found.size() - images > MessengerFiles.FILES_PER_MESSAGE) throw fail(413, "ATTACHMENT_TOO_MANY");
        if (total > MessengerFiles.MESSAGE_MAX) throw fail(413, "ATTACHMENT_TOO_LARGE");
        // In the order the person chose them.
        return wanted.stream().map(w -> found.stream().filter(f -> f.id().equals(w)).findFirst().orElseThrow()).toList();
    }

    JsonNode attachmentNote(List<FileRow> attached) {
        if (attached.isEmpty()) return null;
        long images = attached.stream().filter(f -> "IMAGE".equals(f.kind())).count();
        com.fasterxml.jackson.databind.node.ObjectNode note = json.createObjectNode();
        note.putObject("att").put("images", images).put("files", attached.size() - images);
        return note;
    }

    /** A reply answers a message of this same conversation that the person can still see. */
    Long replyTarget(UUID conversation, long floor, Long replyTo) {
        if (replyTo == null) return null;
        MessengerRooms.Target t = rooms.target(replyTo).orElseThrow(() -> fail(404, "MESSAGE_NOT_FOUND"));
        if (!t.conversation().equals(conversation) || t.id() <= floor || "SYSTEM".equals(t.kind())) throw fail(404, "MESSAGE_NOT_FOUND");
        return t.id();
    }

    public Message send(long me, UUID id, SendRequest request) { return send(me, side(me, id), request); }

    Message send(long me, Side side, SendRequest request) {
        if (request == null || request.ref() == null) throw fail(400, "INVALID_REQUEST");
        UUID id = side.id();
        boolean carries = request.attachments() != null && !request.attachments().isEmpty();
        String body = clean(request.body(), carries);
        // A retry of what already went answers what went, whatever has changed since. Asked only when something would refuse it: the insert itself keeps a retry to one message.
        String why = refused(side);
        if (why != null) return repo.messageByRef(me, request.ref()).orElseThrow(() -> fail(403, why));
        limit("send", me, 40, 60_000);
        if (!side.connected()) {
            if ("PENDING".equals(side.requestState())) {
                if (repo.sentBy(id, me, REQUEST_MESSAGES) >= REQUEST_MESSAGES) return repo.messageByRef(me, request.ref()).orElseThrow(() -> fail(429, "REQUEST_LIMIT"));
            } else {
                limit("request", me, 10, HOUR);
                if (!repo.startRequest(id, me)) throw fail(409, "REQUEST_CLOSED");
            }
            // A first message to someone who has not said yes is words only.
            if (carries) throw fail(403, "NOT_CONNECTED");
            return deliverRequest(side, body, request.ref());
        }
        if (!carries && request.replyTo() == null) return deliver(side, "TEXT", body, null, request.ref());
        // Asked before anything is written: a retry of what already went must not be refused for files that are no longer waiting.
        Optional<Message> already = repo.messageByRef(me, request.ref());
        if (already.isPresent()) return already.get();
        List<FileRow> attached = filesFor(me, id, request.attachments());
        Long replyTo = replyTarget(id, side.myHidden(), request.replyTo());
        boolean online = !side.restrictsMe() && push.online(side.otherPrincipal());
        Long created = tx.execute(status -> {
            Optional<Inserted> row = repo.insert(id, me, side.other(), "TEXT", body, attachmentNote(attached), request.ref(), online, replyTo);
            if (row.isEmpty()) return null;
            if (!attached.isEmpty() && rooms.attach(me, id, row.get().id(), attached.stream().map(FileRow::id).toList()) != attached.size()) throw fail(409, "ATTACHMENT_GONE");
            return row.get().id();
        });
        if (created == null) return repo.messageByRef(me, request.ref()).orElseThrow();
        Message message = repo.messageById(me, created).orElseThrow();
        announce(side, message, online);
        return message;
    }

    private Message built(Side side, Inserted row, String kind, String body, JsonNode payload, UUID ref) {
        return new Message(row.id(), side.id(), side.me(), kind, body, payload, ref, row.at(), null, side.myName(), null, null, List.of(), List.of(), false);
    }

    /** It waits in their Requests: no card with the words, no unread number, once on the bell. */
    private Message deliverRequest(Side side, String body, UUID ref) {
        Optional<Inserted> row = repo.insert(side.id(), side.me(), side.other(), "TEXT", body, null, ref, false);
        if (row.isEmpty()) return repo.messageByRef(side.me(), ref).orElseThrow();
        Message message = built(side, row.get(), "TEXT", body, null, ref);
        push.send(side.otherPrincipal(), Event.request(side.id(), side.me(), side.myName()));
        push.send(side.myPrincipal(), Event.message(side.id(), message, side.myName()));
        remindPerson(side.other(), side.myName() + " muốn nhắn tin cho bạn.", "/community/messages?view=requests", "messenger_request_" + side.id());
        return message;
    }

    public Message share(long me, UUID id, ShareRequest request) {
        if (request == null || request.ref() == null || request.targetId() == null) throw fail(400, "INVALID_REQUEST");
        Side side = side(me, id);
        if (refused(side) != null || !side.connected()) {
            Optional<Message> sent = repo.messageByRef(me, request.ref());
            if (sent.isPresent()) return sent.get();
        }
        mustBeConnected(side);
        limit("send", me, 40, 60_000);
        // Only what the other person is allowed to open: SYSTEM content. A learner's own file is theirs.
        String kind = "READING".equals(request.kind()) ? "SHARE_READING" : "DECK".equals(request.kind()) ? "SHARE_DECK" : null;
        if (kind == null) throw fail(400, "INVALID_REQUEST");
        String title = (kind.equals("SHARE_READING") ? repo.systemReadingTitle(request.targetId()) : repo.systemDeckTitle(request.targetId())).orElseThrow(() -> fail(404, "CONTENT_NOT_FOUND"));
        JsonNode payload = json.createObjectNode().put("id", request.targetId()).put("title", title);
        return deliver(side, kind, title, payload, request.ref());
    }

    Message deliver(Side side, String kind, String body, JsonNode payload, UUID ref) {
        boolean online = !side.restrictsMe() && push.online(side.otherPrincipal());
        Optional<Inserted> row = repo.insert(side.id(), side.me(), side.other(), kind, body, payload, ref, online);
        if (row.isEmpty()) return repo.messageByRef(side.me(), ref).orElseThrow();
        Message message = built(side, row.get(), kind, body, payload, ref);
        announce(side, message, online);
        return message;
    }

    void announce(Side side, Message message, boolean online) {
        Event event = Event.message(side.id(), message, side.myName());
        // Someone who restricted the sender gets the message without a card, a bell or a number.
        push.send(side.otherPrincipal(), side.restrictsMe() ? event.quietly() : event);
        push.send(side.myPrincipal(), event);
        if (online && !side.restrictsMe()) push.send(side.myPrincipal(), Event.delivered(side.id(), side.other(), message.id()));
        else if (!online && !side.otherMuted() && !side.restrictsMe() && !"SYSTEM".equals(message.kind()))
            remind(side, !"TEXT".equals(message.kind()) ? "đã gửi cho bạn một mục học." : message.attachments().isEmpty() ? "đã nhắn tin cho bạn." : "đã gửi cho bạn một tệp.", "messenger_msg_" + side.id() + "_" + LocalDate.now(LOCAL));
    }

    /** Someone away from every page sees it on the bell when they return: once a day per conversation, never the words of the message. */
    void remind(Side side, String words, String key) {
        if (!remembered(key)) return;
        try {
            notifications.create(new CreateNotificationCommand(side.other(), NotificationCategory.COMMUNITY, NotificationType.COMMUNITY_INTERACTION, "Echo Messenger", side.myName() + " " + words, "/community/messages?c=" + side.id(), key));
        } catch (RuntimeException e) {
            reminded.remove(key);
            log.warn("[Messenger] reminder not created: {}", e.getClass().getSimpleName());
        }
    }

    private boolean remembered(String key) {
        if (reminded.size() > 8192) reminded.clear();
        return reminded.add(key);
    }

    void remindPerson(long user, String words, String href, String key) {
        if (!remembered(key)) return;
        try {
            notifications.create(new CreateNotificationCommand(user, NotificationCategory.COMMUNITY, NotificationType.COMMUNITY_INTERACTION, "Echo Messenger", words, href, key));
        } catch (RuntimeException e) {
            reminded.remove(key);
            log.warn("[Messenger] reminder not created: {}", e.getClass().getSimpleName());
        }
    }

    public void read(long me, UUID id, long upTo) { read(me, side(me, id), upTo); }

    void read(long me, Side side, long upTo) {
        limit("read", me, 120, 60_000);
        UUID id = side.id();
        repo.markRead(me, id, upTo);
        Event event = Event.read(id, me, upTo);
        // Someone I restricted is not told what I have read; neither is someone whose request I have not answered.
        if (!side.waitingForMe() && !side.iRestricted()) push.send(side.otherPrincipal(), event);
        push.send(side.myPrincipal(), event);
    }

    public void settings(long me, UUID id, SettingsRequest request) {
        Side side = side(me, id);
        if (request.muted() != null) repo.setMuted(me, id, request.muted());
        if (Boolean.TRUE.equals(request.hidden())) repo.hide(me, id);
        push.send(side.myPrincipal(), Event.people());
    }

    void forgetTyping() { typingMemo.clear(); }

    /** Remembered for a moment: typing goes on the queue only, and must not cost a database round trip per burst of keys. The first thing to go when the server is busy. */
    public void typing(long me, UUID id) {
        long now = System.currentTimeMillis();
        Long last = lastTyping.get(me);
        if (last != null && now - last < 1500) return;
        lastTyping.put(me, now);
        if (lastTyping.size() > 8192) lastTyping.clear();
        String key = me + ":" + id;
        Memo memo = typingMemo.get(key);
        if (memo == null || memo.until < now) {
            if (load.busy()) return;
            Side side = repo.side(me, id).orElse(null);
            if (side == null) return;
            if (typingMemo.size() > 4096) typingMemo.clear();
            memo = new Memo(side, now + 60_000);
            typingMemo.put(key, memo);
        }
        Side side = memo.side;
        if (!side.connected() || side.iBlocked() || side.theyBlocked() || side.restrictsMe() || side.iRestricted()) return;
        push.send(side.otherPrincipal(), Event.typing(id, me, null));
    }

    // ── Speaking Arena invitations ──────────────────────────
    public Message invite(long me, UUID id, InviteRequest request) {
        if (request == null || request.ref() == null) throw fail(400, "INVALID_REQUEST");
        String mode = request.mode() == null ? "FREE" : request.mode();
        if (!MODES.contains(mode)) throw fail(400, "INVALID_REQUEST");
        Side side = side(me, id);
        Optional<Message> sent = repo.messageByRef(me, request.ref());
        if (sent.isPresent()) return sent.get();
        mustBeConnected(side);
        if(request.roomId()!=null)arena.boundRoom(request.roomId(),me,side.other(),mode,false);
        limit("invite", me, 8, 600_000);
        boolean online = !side.restrictsMe() && push.online(side.otherPrincipal());
        UUID invite = UUID.randomUUID();
        Instant expires = Instant.now().plus(INVITE_LIFE);
        Long messageId = tx.execute(status -> {
            repo.retireExpired(id);
            if (repo.pendingIn(id).isPresent()) throw fail(409, "INVITE_PENDING");
            long created = repo.insert(id, me, side.other(), "ARENA_INVITE", "Mời vào Speaking Arena", json.createObjectNode().put("mode", mode), request.ref(), online).orElseThrow(() -> fail(409, "INVITE_PENDING")).id();
            if (!repo.insertInvite(invite, id, created, me, side.other(), mode, expires,request.roomId())) throw fail(409, "INVITE_PENDING");
            return created;
        });
        Message message = repo.messageById(me, messageId).orElseThrow();
        Event event = Event.message(id, message, side.myName());
        push.send(side.otherPrincipal(), side.restrictsMe() ? event.quietly() : event);
        push.send(side.myPrincipal(), event);
        if (!side.restrictsMe()) {
            push.send(side.otherPrincipal(), Event.invite(id, message.invite(), side.myName()));
            if (!side.otherMuted()) remind(side, "mời bạn vào Speaking Arena.", "messenger_invite_" + invite);
        }
        return message;
    }

    public List<Invite> roomInvites(long me,UUID room){
        return repo.roomInvites(me,room).stream().map(row->live(view(row,row.status(),row.code()))).toList();
    }

    private Invite view(InviteRow row, String status, String code) {
        return new Invite(row.id(), status, row.mode(), row.inviter(), row.invitee(), row.expires(), code);
    }

    private void tellBoth(InviteRow row, Invite view, long actor) {
        String name = nameOf(actor);
        Event event = Event.invite(row.conversation(), view, name);
        repo.personById(row.inviter()).ifPresent(p -> push.send(p.principal(), event));
        repo.personById(row.invitee()).ifPresent(p -> push.send(p.principal(), event));
    }

    private InviteRow inviteRow(long me, UUID id) { return repo.inviteFor(me, id).orElseThrow(() -> fail(404, "INVITE_NOT_FOUND")); }

    /** Only the person invited says yes. The room is found or kept for the two of them only now, and nobody is moved anywhere by it. */
    public Invite accept(long me, UUID id) {
        InviteRow row = inviteRow(me, id);
        if (row.invitee() != me) throw fail(403, "NOT_INVITED");
        if (repo.blockedEitherWay(row.inviter(), row.invitee())) {
            repo.respond(id, "CANCELLED", null);
            throw fail(403, "UNAVAILABLE");
        }
        if (!"PENDING".equals(row.status())) {
            if ("ACCEPTED".equals(row.status())) return live(view(row, row.status(), row.code()));
            throw fail(409, "INVITE_CLOSED");
        }
        if (row.expires().isBefore(Instant.now())) throw fail(410, "INVITE_EXPIRED");
        String code = row.targetRoom()==null?arena.reserve(row.mode(), row.inviter(), row.invitee()):arena.boundRoom(row.targetRoom(),row.inviter(),row.invitee(),row.mode(),true);
        if (!repo.respond(id, "ACCEPTED", code)) throw fail(409, "INVITE_CLOSED");
        Invite view = view(row, "ACCEPTED", code);
        tellBoth(row, view, me);
        return view;
    }

    public Invite decline(long me, UUID id) {
        InviteRow row = inviteRow(me, id);
        if (row.invitee() != me) throw fail(403, "NOT_INVITED");
        if (!repo.respond(id, "DECLINED", null)) throw fail(409, "INVITE_CLOSED");
        Invite view = view(row, "DECLINED", null);
        tellBoth(row, view, me);
        return view;
    }

    public Invite cancel(long me, UUID id) {
        InviteRow row = inviteRow(me, id);
        if (row.inviter() != me) throw fail(403, "NOT_INVITED");
        if (!repo.respond(id, "CANCELLED", null)) throw fail(409, "INVITE_CLOSED");
        Invite view = view(row, "CANCELLED", null);
        tellBoth(row, view, me);
        return view;
    }
}
