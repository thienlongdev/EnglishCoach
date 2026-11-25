package com.englishcoach.messenger;

import com.englishcoach.messenger.MessengerDtos.Invite;
import com.englishcoach.messenger.MessengerDtos.Message;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Every statement names the person asking, so another learner's conversation is simply not found. The production database is a network round trip
 * away: what belongs together is one statement (a message and its conversation row; a list and its unread counts).
 */
@Repository
public class MessengerRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public MessengerRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    // ── People ──────────────────────────────────────────────
    /** A row of people, with what is needed to reach them. The address stays on this side of the API. */
    public record PersonRow(long id, String name, boolean avatar, String principal, String username, String relation, boolean seesActivity, Instant lastSeen) {
        public PersonRow(long id, String name, boolean avatar, String principal, String username, String relation) { this(id, name, avatar, principal, username, relation, false, null); }
    }

    /** The person asking, named once at the head of a statement so every fragment can refer to them. */
    static final String ME = "WITH v AS (SELECT ?::bigint AS me) ";
    /**
     * May the person asking see this person's activity (online, last seen)? Both must be showing their own, and this person must not have restricted them.
     * Needs {@link #ME} at the head of the statement and the directory joined as {@code d}.
     */
    static String activity(String user) {
        return ", (coalesce(d.show_activity, TRUE)"
                + " AND coalesce((SELECT x.show_activity FROM public.messenger_directory x WHERE x.user_id = (SELECT me FROM v)), TRUE)"
                + " AND NOT EXISTS (SELECT 1 FROM public.messenger_restrictions rs WHERE rs.user_id = " + user + ".id AND rs.restricted_id = (SELECT me FROM v))) AS sees_activity, d.last_seen_at";
    }

    private static final String PERSON = """
            u.id, u.email, d.username,
            coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(u.name), ''), 'Học viên') AS shown,
            p.avatar_storage_key IS NOT NULL AND p.avatar_storage_key <> '' AS has_avatar""";
    private static final String ACTIVE = " u.account_status = 'ACTIVE' ";
    private static final String FROM_PERSON = " LEFT JOIN public.user_profiles p ON p.user_id = u.id LEFT JOIN public.messenger_directory d ON d.user_id = u.id ";
    private static final String RELATION = """
            CASE WHEN EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE b.blocker_id = ? AND b.blocked_id = u.id) THEN 'BLOCKED'
                 WHEN mine.id IS NOT NULL AND theirs.id IS NOT NULL THEN 'FRIEND'
                 WHEN theirs.id IS NOT NULL THEN 'INCOMING'
                 WHEN mine.id IS NOT NULL THEN 'OUTGOING'
                 ELSE 'NONE' END AS relation""";
    private static final String JOIN_RELATION = " LEFT JOIN public.community_follows mine ON mine.follower_user_id = ? AND mine.following_user_id = u.id"
            + " LEFT JOIN public.community_follows theirs ON theirs.follower_user_id = u.id AND theirs.following_user_id = ?";

    private static String shownOf(String shown) { return shown.contains("@") ? "Học viên" : shown; }

    private PersonRow person(ResultSet rs, String relation) throws SQLException {
        return new PersonRow(rs.getLong("id"), shownOf(rs.getString("shown")), rs.getBoolean("has_avatar"), rs.getString("email"), rs.getString("username"), relation);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp t = rs.getTimestamp(column);
        return t == null ? null : t.toInstant();
    }

    PersonRow personSeen(ResultSet rs, String relation) throws SQLException {
        return new PersonRow(rs.getLong("id"), shownOf(rs.getString("shown")), rs.getBoolean("has_avatar"), rs.getString("email"), rs.getString("username"), relation, rs.getBoolean("sees_activity"), instant(rs, "last_seen_at"));
    }

    private static final String NOT_BLOCKED = " AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)) ";

    public record PeopleRows(List<PersonRow> friends, List<PersonRow> incoming, List<PersonRow> outgoing, List<PersonRow> blocked, boolean moreFriends, List<PersonRow> restricted) {}

    /** Everything on the Friends and Requests views in one statement: the database is a network round trip away. */
    public PeopleRows people(long me, int friendsLimit, int friendsOffset) {
        List<PersonRow> friends = new java.util.ArrayList<>(), incoming = new java.util.ArrayList<>(), outgoing = new java.util.ArrayList<>(), blocked = new java.util.ArrayList<>(), restricted = new java.util.ArrayList<>();
        jdbc.query(ME + "SELECT x.kind, " + PERSON + activity("u") + " FROM (("
                + " SELECT 'F' AS kind, m.following_user_id AS uid FROM public.community_follows m JOIN public.community_follows t ON t.follower_user_id = m.following_user_id AND t.following_user_id = m.follower_user_id"
                + " JOIN public.users fu ON fu.id = m.following_user_id LEFT JOIN public.user_profiles fp ON fp.user_id = fu.id"
                + " WHERE m.follower_user_id = ? AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = fu.id) OR (b.blocker_id = fu.id AND b.blocked_id = ?))"
                + " ORDER BY coalesce(nullif(btrim(fp.display_name), ''), fu.name), fu.id LIMIT ? OFFSET ?)"
                + " UNION ALL (SELECT 'I', f.follower_user_id FROM public.community_follows f WHERE f.following_user_id = ?"
                + "   AND NOT EXISTS (SELECT 1 FROM public.community_follows r WHERE r.follower_user_id = ? AND r.following_user_id = f.follower_user_id)"
                + "   AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = f.follower_user_id) OR (b.blocker_id = f.follower_user_id AND b.blocked_id = ?))"
                + "   ORDER BY f.created_at DESC LIMIT 60)"
                + " UNION ALL (SELECT 'O', f.following_user_id FROM public.community_follows f WHERE f.follower_user_id = ?"
                + "   AND NOT EXISTS (SELECT 1 FROM public.community_follows r WHERE r.follower_user_id = f.following_user_id AND r.following_user_id = ?)"
                + "   AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = f.following_user_id) OR (b.blocker_id = f.following_user_id AND b.blocked_id = ?))"
                + "   ORDER BY f.created_at DESC LIMIT 60)"
                + " UNION ALL (SELECT 'B', b.blocked_id FROM public.messenger_blocks b WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT 100)"
                + " UNION ALL (SELECT 'R', r.restricted_id FROM public.messenger_restrictions r WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 100)"
                + " ) x JOIN public.users u ON u.id = x.uid" + FROM_PERSON + " WHERE" + ACTIVE + " ORDER BY x.kind, shown, u.id",
                (ResultSet rs) -> {
                    String kind = rs.getString("kind");
                    switch (kind) {
                        case "F" -> friends.add(personSeen(rs, "FRIEND"));
                        case "R" -> restricted.add(person(rs, null));
                        case "I" -> incoming.add(person(rs, "INCOMING"));
                        case "O" -> outgoing.add(person(rs, "OUTGOING"));
                        default -> blocked.add(person(rs, "BLOCKED"));
                    }
                }, me, me, me, me, friendsLimit + 1, friendsOffset, me, me, me, me, me, me, me, me, me, me);
        boolean more = friends.size() > friendsLimit;
        return new PeopleRows(more ? friends.subList(0, friendsLimit) : friends, incoming, outgoing, blocked, more, restricted);
    }

    /**
     * Only what presence needs: friends who may see this person's activity. Nobody when the person hides it; never someone they restricted or who hides their own;
     * never across a block.
     */
    public List<String> friendPrincipals(long me) {
        return jdbc.query("""
                SELECT u.email FROM public.community_follows m JOIN public.community_follows t ON t.follower_user_id = m.following_user_id AND t.following_user_id = m.follower_user_id
                JOIN public.users u ON u.id = m.following_user_id LEFT JOIN public.messenger_directory fd ON fd.user_id = u.id
                WHERE m.follower_user_id = ?
                  AND coalesce((SELECT x.show_activity FROM public.messenger_directory x WHERE x.user_id = ?), TRUE) AND coalesce(fd.show_activity, TRUE)
                  AND NOT EXISTS (SELECT 1 FROM public.messenger_restrictions r WHERE r.user_id = ? AND r.restricted_id = u.id)
                  AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?))
                LIMIT 300""", (rs, n) -> rs.getString(1), me, me, me, me, me);
    }

    /** Written when the last page of a person has closed (and for everyone online when the server stops): never while they are online. */
    public void lastSeen(java.util.Collection<Long> users) {
        if (users.isEmpty()) return;
        jdbc.update("UPDATE public.messenger_directory SET last_seen_at = now() WHERE user_id = ANY (?)", ps -> ps.setArray(1, ps.getConnection().createArrayOf("bigint", users.toArray())));
    }

    public Instant lastSeenOf(long user) {
        return jdbc.query("SELECT last_seen_at FROM public.messenger_directory WHERE user_id = ?", (rs, n) -> instant(rs, "last_seen_at"), user).stream().filter(java.util.Objects::nonNull).findFirst().orElse(null);
    }

    /**
     * People by the first letters of the words of their name, or by @username. Both are served by an index, whatever the number of accounts; a name that is an address was never
     * indexed. A hidden person is found only by their exact @username. Keyset on the username: page N costs what page 1 costs.
     */
    public List<PersonRow> search(long me, java.util.List<String> words, String usernamePrefix, String exactUsername, String after, int limit) {
        String like = usernamePrefix == null ? null : usernamePrefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
        StringBuilder where = new StringBuilder();
        List<Object> args = new java.util.ArrayList<>(List.of(me, me, me));
        where.append(" WHERE d.user_id <> ? AND").append(ACTIVE).append(" AND (");
        args.add(me);
        boolean any = false;
        if (!words.isEmpty()) {
            where.append("(d.discoverable AND d.name_prefixes @> ?::text[])");
            args.add("{" + String.join(",", words) + "}");
            any = true;
        }
        if (like != null) {
            where.append(any ? " OR " : "").append("(d.discoverable AND d.username LIKE ? ESCAPE '\\')");
            args.add(like);
            any = true;
        }
        where.append(any ? " OR " : "").append("d.username = ?)");
        args.add(exactUsername == null ? "" : exactUsername);
        where.append(NOT_BLOCKED);
        args.add(me); args.add(me);
        if (after != null) { where.append(" AND d.username COLLATE \"C\" > ?"); args.add(after); }
        args.add(limit);
        return jdbc.query("SELECT " + PERSON + ", " + RELATION + " FROM public.messenger_directory d JOIN public.users u ON u.id = d.user_id LEFT JOIN public.user_profiles p ON p.user_id = u.id" + JOIN_RELATION
                + where + " ORDER BY d.username COLLATE \"C\" LIMIT ?", (rs, n) -> person(rs, rs.getString("relation")), args.toArray());
    }

    public Optional<PersonRow> personById(long id) {
        return jdbc.query("SELECT " + PERSON + " FROM public.users u" + FROM_PERSON + " WHERE u.id = ? AND" + ACTIVE, (rs, n) -> person(rs, null), id).stream().findFirst();
    }

    public record Relation(PersonRow person, boolean theyBlockedMe, String policy, UUID conversation, String requestState, Long requestBy, boolean iRestricted) {
        boolean friends() { return "FRIEND".equals(person.relation()); }
        boolean iBlocked() { return "BLOCKED".equals(person.relation()); }
    }

    /** Who someone is from my side, in one statement. */
    public Optional<Relation> relation(long me, long other) {
        return jdbc.query(ME + "SELECT " + PERSON + activity("u") + ", " + RELATION + """
                , coalesce(d.message_policy, 'EVERYONE') AS policy,
                  EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = (SELECT me FROM v) AND x.restricted_id = u.id) AS i_restricted,
                  EXISTS (SELECT 1 FROM public.messenger_blocks x WHERE x.blocker_id = u.id AND x.blocked_id = ?) AS they_blocked,
                  c.id AS conversation, c.request_state, c.request_by
                FROM public.users u""" + FROM_PERSON + JOIN_RELATION
                + " LEFT JOIN public.messenger_conversations c ON c.user_low = LEAST(?::bigint, u.id) AND c.user_high = GREATEST(?::bigint, u.id) WHERE u.id = ? AND" + ACTIVE, (rs, n) -> {
                    long by = rs.getLong("request_by");
                    Long requestBy = rs.wasNull() ? null : by;
                    return new Relation(personSeen(rs, rs.getString("relation")), rs.getBoolean("they_blocked"), rs.getString("policy"), rs.getObject("conversation", UUID.class), rs.getString("request_state"), requestBy, rs.getBoolean("i_restricted"));
                }, me, me, me, me, me, me, me, other).stream().findFirst();
    }

    public boolean follows(long from, long to) {
        Boolean yes = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM public.community_follows WHERE follower_user_id = ? AND following_user_id = ?)", Boolean.class, from, to);
        return Boolean.TRUE.equals(yes);
    }

    public boolean blockedEitherWay(long a, long b) {
        Boolean yes = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM public.messenger_blocks z WHERE (z.blocker_id = ? AND z.blocked_id = ?) OR (z.blocker_id = ? AND z.blocked_id = ?))", Boolean.class, a, b, b, a);
        return Boolean.TRUE.equals(yes);
    }

    public void block(long me, long other) {
        jdbc.update("INSERT INTO public.messenger_blocks (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT DO NOTHING", me, other);
    }

    public void unblock(long me, long other) {
        jdbc.update("DELETE FROM public.messenger_blocks WHERE blocker_id = ? AND blocked_id = ?", me, other);
    }

    // ── The person's own card ───────────────────────────────
    public record MeRow(String username, String policy, boolean discoverable, boolean showActivity) {}

    public Optional<MeRow> me(long me) {
        return jdbc.query("SELECT username, message_policy, discoverable, show_activity FROM public.messenger_directory WHERE user_id = ?", (rs, n) -> new MeRow(rs.getString(1), rs.getString(2), rs.getBoolean(3), rs.getBoolean(4)), me).stream().findFirst();
    }

    /** False: the name is someone else's. */
    public boolean updateMe(long me, String username, String policy, Boolean discoverable, Boolean showActivity) {
        try {
            jdbc.update("UPDATE public.messenger_directory SET username = coalesce(?, username), message_policy = coalesce(?, message_policy), discoverable = coalesce(?, discoverable), show_activity = coalesce(?, show_activity), updated_at = now() WHERE user_id = ?",
                    username, policy, discoverable, showActivity, me);
            return true;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }

    // ── Conversations ───────────────────────────────────────
    /** The conversation seen from one side: the pair, the markers, whether a message may go. */
    public record Side(UUID id, long me, long other, String otherPrincipal, String otherName, boolean otherAvatar, boolean otherActive, boolean friends, boolean iBlocked, boolean theyBlocked, boolean restricted, boolean otherMuted, long myHidden,
                       String requestState, Long requestBy, String otherPolicy, String otherUsername, String myPrincipal, String myName,
                       boolean seesActivity, Instant otherLastSeen, boolean iRestricted, boolean restrictsMe, String theme, long lastMessageId) {
        boolean low() { return me < other; }
        boolean connected() { return friends || "ACCEPTED".equals(requestState); }
        boolean waitingForMe() { return "PENDING".equals(requestState) && requestBy != null && requestBy != me; }
    }

    public Optional<Side> side(long me, UUID id) {
        return jdbc.query(ME + """
                SELECT c.id, ?::bigint AS me, o.id AS other, o.email, o.account_status = 'ACTIVE' AS active,
                       c.theme, coalesce(c.last_message_id, 0) AS last_id,
                       EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = (SELECT me FROM v) AND x.restricted_id = o.id) AS i_restricted,
                       EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = o.id AND x.restricted_id = (SELECT me FROM v)) AS restricts_me,
                       coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(o.name), ''), 'Học viên') AS shown,
                       p.avatar_storage_key IS NOT NULL AND p.avatar_storage_key <> '' AS has_avatar,
                       EXISTS (SELECT 1 FROM public.community_follows a JOIN public.community_follows b ON b.follower_user_id = a.following_user_id AND b.following_user_id = a.follower_user_id
                               WHERE a.follower_user_id = ? AND a.following_user_id = o.id) AS friends,
                       EXISTS (SELECT 1 FROM public.messenger_blocks x WHERE x.blocker_id = ? AND x.blocked_id = o.id) AS i_blocked,
                       EXISTS (SELECT 1 FROM public.messenger_blocks x WHERE x.blocker_id = o.id AND x.blocked_id = ?) AS they_blocked,
                       EXISTS (SELECT 1 FROM public.community_user_restrictions r WHERE r.target_user_id = ? AND r.restriction_type IN ('SUSPEND_COMMUNITY', 'READ_ONLY') AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())) AS restricted,
                       (CASE WHEN c.user_low = ? THEN c.high_muted ELSE c.low_muted END
                          OR EXISTS (SELECT 1 FROM public.messenger_prefs q WHERE q.conversation_id = c.id AND q.user_id = o.id AND q.muted_until > now())) AS other_muted,
                       CASE WHEN c.user_low = ? THEN c.low_hidden_id ELSE c.high_hidden_id END AS my_hidden,
                       c.request_state, c.request_by, coalesce(d.message_policy, 'EVERYONE') AS policy, d.username,
                       self.email AS my_email, coalesce(nullif(btrim(sp.display_name), ''), nullif(btrim(self.name), ''), 'Học viên') AS my_shown""" + activity("o") + """

                FROM public.messenger_conversations c
                JOIN public.users o ON o.id = CASE WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END
                JOIN public.users self ON self.id = ?
                LEFT JOIN public.user_profiles p ON p.user_id = o.id
                LEFT JOIN public.user_profiles sp ON sp.user_id = self.id
                LEFT JOIN public.messenger_directory d ON d.user_id = o.id
                WHERE c.id = ? AND (c.user_low = ? OR c.user_high = ?)""",
                (rs, n) -> {
                    String shown = rs.getString("shown");
                    long by = rs.getLong("request_by");
                    Long requestBy = rs.wasNull() ? null : by;
                    return new Side(rs.getObject("id", UUID.class), rs.getLong("me"), rs.getLong("other"), rs.getString("email"), shownOf(shown), rs.getBoolean("has_avatar"), rs.getBoolean("active"),
                            rs.getBoolean("friends"), rs.getBoolean("i_blocked"), rs.getBoolean("they_blocked"), rs.getBoolean("restricted"), rs.getBoolean("other_muted"), rs.getLong("my_hidden"),
                            rs.getString("request_state"), requestBy, rs.getString("policy"), rs.getString("username"), rs.getString("my_email"), shownOf(rs.getString("my_shown")),
                            rs.getBoolean("sees_activity"), instant(rs, "last_seen_at"), rs.getBoolean("i_restricted"), rs.getBoolean("restricts_me"), rs.getString("theme"), rs.getLong("last_id"));
                }, me, me, me, me, me, me, me, me, me, me, id, me, me).stream().findFirst();
    }

    public boolean friends(long a, long b) {
        Boolean yes = jdbc.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM public.community_follows x JOIN public.community_follows y ON y.follower_user_id = x.following_user_id AND y.following_user_id = x.follower_user_id
                               WHERE x.follower_user_id = ? AND x.following_user_id = ?)
                   AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks z WHERE (z.blocker_id = ? AND z.blocked_id = ?) OR (z.blocker_id = ? AND z.blocked_id = ?))""", Boolean.class, a, b, a, b, b, a);
        return Boolean.TRUE.equals(yes);
    }

    public UUID openConversation(long a, long b) {
        long low = Math.min(a, b), high = Math.max(a, b);
        return jdbc.queryForObject("""
                INSERT INTO public.messenger_conversations (id, user_low, user_high) VALUES (?, ?, ?)
                ON CONFLICT (user_low, user_high) DO UPDATE SET user_low = EXCLUDED.user_low RETURNING id""", UUID.class, UUID.randomUUID(), low, high);
    }

    /** One row per conversation with the last message and the unread count, in one statement. A count stops at 100: nobody needs more than "99+". */
    public record ConversationRow(UUID id, PersonRow other, Message last, int unread, long myRead, long theirRead, long theirDelivered, boolean muted, boolean friends, boolean iBlocked, boolean theyBlocked, boolean restricted, String requestState, Long requestBy, String otherPolicy, Instant at,
                                  String theme, Instant mutedUntil, boolean pinned, boolean archived, boolean markedUnread, boolean iRestricted) {}

    /** A date this far away means "until I turn it back on". */
    static final Instant FOREVER = Instant.parse("9999-01-01T00:00:00Z");

    private static final String CONVERSATION = ME + """
            SELECT c.id AS conversation, o.id, o.email, d.username, coalesce(d.message_policy, 'EVERYONE') AS policy, c.request_state, c.request_by, c.last_message_at,
                   c.theme, pf.muted_until, pf.pinned_at, coalesce(pf.marked_unread, FALSE) AS marked_unread,
                   coalesce(pf.archived_id, 0) >= c.last_message_id AS archived,
                   EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = (SELECT me FROM v) AND x.restricted_id = o.id) AS i_restricted,
                   EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = o.id AND x.restricted_id = (SELECT me FROM v)) AS restricts_me,
                   coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(o.name), ''), 'Học viên') AS shown,
                   p.avatar_storage_key IS NOT NULL AND p.avatar_storage_key <> '' AS has_avatar,
                   CASE WHEN c.user_low = ? THEN c.low_read_id ELSE c.high_read_id END AS my_read,
                   CASE WHEN c.user_low = ? THEN c.high_read_id ELSE c.low_read_id END AS their_read,
                   CASE WHEN c.user_low = ? THEN c.high_delivered_id ELSE c.low_delivered_id END AS their_delivered,
                   CASE WHEN c.user_low = ? THEN c.low_muted ELSE c.high_muted END AS muted,
                   (SELECT count(*) FROM (SELECT 1 FROM public.messenger_messages u WHERE u.conversation_id = c.id AND u.sender_id <> ?
                      AND u.id > GREATEST(CASE WHEN c.user_low = ? THEN c.low_read_id ELSE c.high_read_id END, CASE WHEN c.user_low = ? THEN c.low_hidden_id ELSE c.high_hidden_id END) LIMIT 100) n) AS unread,
                   EXISTS (SELECT 1 FROM public.community_follows a JOIN public.community_follows b ON b.follower_user_id = a.following_user_id AND b.following_user_id = a.follower_user_id
                           WHERE a.follower_user_id = ? AND a.following_user_id = o.id) AS friends,
                   EXISTS (SELECT 1 FROM public.messenger_blocks x WHERE x.blocker_id = ? AND x.blocked_id = o.id) AS i_blocked,
                   EXISTS (SELECT 1 FROM public.messenger_blocks x WHERE x.blocker_id = o.id AND x.blocked_id = ?) AS they_blocked,
                   EXISTS (SELECT 1 FROM public.community_user_restrictions r WHERE r.target_user_id = ? AND r.restriction_type IN ('SUSPEND_COMMUNITY', 'READ_ONLY') AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())) AS restricted,
                   m.id AS m_id, m.conversation_id AS m_conversation, m.sender_id AS m_sender, m.kind AS m_kind, m.body AS m_body, m.payload AS m_payload, m.client_ref AS m_ref, m.created_at AS m_at, m.deleted_at AS m_deleted,
                   i.id AS i_id, i.status AS i_status, i.mode AS i_mode, i.inviter_id AS i_inviter, i.invitee_id AS i_invitee, i.expires_at AS i_expires, i.room_code AS i_code""" + activity("o") + """

            FROM public.messenger_conversations c
            JOIN public.users o ON o.id = CASE WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END
            LEFT JOIN public.user_profiles p ON p.user_id = o.id
            LEFT JOIN public.messenger_directory d ON d.user_id = o.id
            LEFT JOIN public.messenger_prefs pf ON pf.conversation_id = c.id AND pf.user_id = (SELECT me FROM v)
            LEFT JOIN public.messenger_messages m ON m.id = c.last_message_id
            LEFT JOIN public.messenger_arena_invites i ON i.message_id = m.id
            WHERE (c.user_low = ? OR c.user_high = ?)
              AND c.last_message_id IS NOT NULL
              AND c.last_message_id > CASE WHEN c.user_low = ? THEN c.low_hidden_id ELSE c.high_hidden_id END""";

    private ConversationRow conversationRow(ResultSet rs, int n) throws SQLException {
        String shown = rs.getString("shown");
        long mid = rs.getLong("m_id");
        Message last = mid == 0 ? null : lastMessage(rs);
        long by = rs.getLong("request_by");
        Long requestBy = rs.wasNull() ? null : by;
        Timestamp at = rs.getTimestamp("last_message_at");
        Instant mutedUntil = instant(rs, "muted_until");
        if (mutedUntil != null && mutedUntil.isBefore(Instant.now())) mutedUntil = null;
        // The old switch (V114) meant "until I turn it back on".
        if (mutedUntil == null && rs.getBoolean("muted")) mutedUntil = FOREVER;
        // Someone who restricted me does not tell me what they have read.
        long theirRead = rs.getBoolean("restricts_me") ? 0 : rs.getLong("their_read");
        return new ConversationRow(rs.getObject("conversation", UUID.class),
                new PersonRow(rs.getLong("id"), shownOf(shown), rs.getBoolean("has_avatar"), rs.getString("email"), rs.getString("username"), null, rs.getBoolean("sees_activity"), instant(rs, "last_seen_at")),
                last, rs.getInt("unread"), rs.getLong("my_read"), theirRead, rs.getLong("their_delivered"),
                mutedUntil != null, rs.getBoolean("friends"), rs.getBoolean("i_blocked"), rs.getBoolean("they_blocked"), rs.getBoolean("restricted"),
                rs.getString("request_state"), requestBy, rs.getString("policy"), at == null ? null : at.toInstant(),
                rs.getString("theme"), mutedUntil, rs.getTimestamp("pinned_at") != null, rs.getBoolean("archived"), rs.getBoolean("marked_unread"), rs.getBoolean("i_restricted"));
    }

    /**
     * The Chats list: what waits in my Requests or what I declined is not here. {@code scope}: MAIN (not archived, not someone I restricted), ARCHIVED, RESTRICTED.
     * Pinned conversations come first, on the first page only; after that, keyset on the time of the last message.
     */
    public List<ConversationRow> conversations(long me, Instant before, int limit, String scope) {
        List<Object> args = new java.util.ArrayList<>(List.of(me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me));
        StringBuilder sql = new StringBuilder(CONVERSATION).append(" AND NOT (c.request_state IN ('PENDING', 'DECLINED') AND c.request_by <> ?)");
        String restricted = "EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = (SELECT me FROM v) AND x.restricted_id = o.id)";
        String archived = "coalesce(pf.archived_id, 0) >= c.last_message_id";
        if ("RESTRICTED".equals(scope)) sql.append(" AND ").append(restricted);
        else if ("ARCHIVED".equals(scope)) sql.append(" AND ").append(archived).append(" AND NOT ").append(restricted);
        else sql.append(" AND NOT ").append(archived).append(" AND NOT ").append(restricted);
        if (before != null) { sql.append(" AND pf.pinned_at IS NULL AND c.last_message_at < ?"); args.add(Timestamp.from(before)); }
        sql.append(" ORDER BY (pf.pinned_at IS NOT NULL) DESC, c.last_message_at DESC NULLS LAST LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), this::conversationRow, args.toArray());
    }

    public Optional<ConversationRow> conversation(long me, UUID id) {
        return jdbc.query(CONVERSATION + " AND c.id = ?", this::conversationRow, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, id).stream().findFirst();
    }

    /** Strangers' first messages, waiting for me. */
    public List<ConversationRow> requests(long me, int limit) {
        return jdbc.query(CONVERSATION + " AND c.request_state = 'PENDING' AND c.request_by <> ? ORDER BY c.last_message_at DESC NULLS LAST LIMIT ?", this::conversationRow,
                me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, limit);
    }

    public record SummaryRow(int unread, int messageRequests, int friendRequests) {}

    /** All a page needs to draw its badge, in one statement, each count stopping at 100. Nothing here is read for someone who is not asking. */
    public SummaryRow summary(long me) {
        return jdbc.queryForObject("""
                SELECT
                 (SELECT count(*) FROM (
                    (SELECT 1 FROM public.messenger_conversations c JOIN public.messenger_messages m ON m.conversation_id = c.id
                     WHERE (c.user_low = ? OR c.user_high = ?) AND m.sender_id <> ?
                      AND NOT (c.request_state IN ('PENDING', 'DECLINED') AND c.request_by <> ?)
                      AND NOT EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.user_id = ? AND x.restricted_id = m.sender_id)
                      AND NOT EXISTS (SELECT 1 FROM public.messenger_prefs pf WHERE pf.conversation_id = c.id AND pf.user_id = ? AND pf.archived_id >= c.last_message_id)
                      AND m.id > GREATEST(CASE WHEN c.user_low = ? THEN c.low_read_id ELSE c.high_read_id END, CASE WHEN c.user_low = ? THEN c.low_hidden_id ELSE c.high_hidden_id END) LIMIT 100)
                    UNION ALL
                    (SELECT 1 FROM public.messenger_members g JOIN public.messenger_conversations gc ON gc.id = g.conversation_id JOIN public.messenger_messages m ON m.conversation_id = g.conversation_id
                     WHERE g.user_id = ? AND g.left_at IS NULL AND m.sender_id <> ? AND g.archived_id < coalesce(gc.last_message_id, 0)
                      AND m.id > GREATEST(g.read_id, g.hidden_id, g.since_id) LIMIT 100)
                    LIMIT 100) a),
                 (SELECT count(*) FROM (SELECT 1 FROM public.messenger_conversations c
                    WHERE (c.user_low = ? OR c.user_high = ?) AND c.request_state = 'PENDING' AND c.request_by <> ? AND c.last_message_id IS NOT NULL LIMIT 100) b),
                 (SELECT count(*) FROM (SELECT 1 FROM public.community_follows f JOIN public.users u ON u.id = f.follower_user_id
                    WHERE f.following_user_id = ? AND u.account_status = 'ACTIVE'
                      AND NOT EXISTS (SELECT 1 FROM public.community_follows r WHERE r.follower_user_id = ? AND r.following_user_id = f.follower_user_id)
                      AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks x WHERE (x.blocker_id = ? AND x.blocked_id = f.follower_user_id) OR (x.blocker_id = f.follower_user_id AND x.blocked_id = ?)) LIMIT 100) c)""",
                (rs, n) -> new SummaryRow(rs.getInt(1), rs.getInt(2), rs.getInt(3)), me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me, me);
    }

    /** A stranger's first message opens a request. False: someone else's request is already here, or it was answered. */
    public boolean startRequest(UUID id, long me) {
        return jdbc.update("""
                UPDATE public.messenger_conversations SET request_state = 'PENDING', request_by = ?
                WHERE id = ? AND (request_state = 'NONE' OR (request_state = 'DECLINED' AND request_by <> ?))""", me, id, me) == 1;
    }

    /** Only the person it waits for answers it, and only once. */
    public boolean answerRequest(UUID id, long me, String answer) {
        return jdbc.update("UPDATE public.messenger_conversations SET request_state = ? WHERE id = ? AND request_state = 'PENDING' AND request_by <> ? AND (user_low = ? OR user_high = ?)", answer, id, me, me, me) == 1;
    }

    /** They became friends: whatever waited between them is answered. */
    public void settleRequest(long a, long b) {
        jdbc.update("UPDATE public.messenger_conversations SET request_state = 'ACCEPTED' WHERE user_low = ? AND user_high = ? AND request_state IN ('PENDING', 'DECLINED')", Math.min(a, b), Math.max(a, b));
    }

    /** No longer friends: anything new starts from the beginning. History stays. */
    public void resetRequest(long a, long b) {
        jdbc.update("UPDATE public.messenger_conversations SET request_state = 'NONE', request_by = NULL WHERE user_low = ? AND user_high = ?", Math.min(a, b), Math.max(a, b));
    }

    /** Blocking is also the answer to what they had asked. */
    public void declinePending(long me, long other) {
        jdbc.update("UPDATE public.messenger_conversations SET request_state = 'DECLINED' WHERE user_low = ? AND user_high = ? AND request_state = 'PENDING' AND request_by = ?", Math.min(me, other), Math.max(me, other), other);
    }

    /** How many messages someone has sent here: a request is a few messages, not a conversation. */
    public int sentBy(UUID conversation, long sender, int stopAt) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM (SELECT 1 FROM public.messenger_messages WHERE conversation_id = ? AND sender_id = ? LIMIT ?) x", Integer.class, conversation, sender, stopAt);
        return n == null ? 0 : n;
    }

    /** Everything addressed to this person up to now has reached them: who needs to be told, and up to which message. */
    public record NewlyDelivered(UUID conversation, long sender, String senderPrincipal, long upTo) {}

    public List<NewlyDelivered> markAllDelivered(long me) {
        return jdbc.query("""
                WITH mine AS (
                  SELECT c.id, CASE WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END AS other, c.last_message_id
                  FROM public.messenger_conversations c JOIN public.messenger_messages m ON m.id = c.last_message_id
                  WHERE (c.user_low = ? OR c.user_high = ?) AND m.sender_id <> ?
                    AND c.last_message_id > CASE WHEN c.user_low = ? THEN c.low_delivered_id ELSE c.high_delivered_id END
                ), done AS (
                  UPDATE public.messenger_conversations c
                  SET low_delivered_id = CASE WHEN c.user_low = ? THEN mine.last_message_id ELSE c.low_delivered_id END,
                      high_delivered_id = CASE WHEN c.user_high = ? THEN mine.last_message_id ELSE c.high_delivered_id END
                  FROM mine WHERE c.id = mine.id RETURNING c.id
                )
                SELECT mine.id, mine.other, u.email, mine.last_message_id FROM mine JOIN done ON done.id = mine.id JOIN public.users u ON u.id = mine.other""",
                (rs, n) -> new NewlyDelivered(rs.getObject(1, UUID.class), rs.getLong(2), rs.getString(3), rs.getLong(4)), me, me, me, me, me, me, me);
    }

    public void markRead(long me, UUID id, long upTo) {
        jdbc.update("""
                WITH seen AS (UPDATE public.messenger_prefs SET marked_unread = FALSE WHERE conversation_id = ? AND user_id = ? AND marked_unread)
                UPDATE public.messenger_conversations c SET
                  low_read_id = CASE WHEN c.user_low = ? THEN GREATEST(c.low_read_id, ?) ELSE c.low_read_id END,
                  high_read_id = CASE WHEN c.user_high = ? THEN GREATEST(c.high_read_id, ?) ELSE c.high_read_id END,
                  low_delivered_id = CASE WHEN c.user_low = ? THEN GREATEST(c.low_delivered_id, ?) ELSE c.low_delivered_id END,
                  high_delivered_id = CASE WHEN c.user_high = ? THEN GREATEST(c.high_delivered_id, ?) ELSE c.high_delivered_id END
                WHERE c.id = ? AND (c.user_low = ? OR c.user_high = ?) AND ? <= coalesce(c.last_message_id, 0)""",
                id, me, me, upTo, me, upTo, me, upTo, me, upTo, id, me, me, upTo);
    }

    public void setMuted(long me, UUID id, boolean muted) {
        jdbc.update("UPDATE public.messenger_conversations c SET low_muted = CASE WHEN c.user_low = ? THEN ? ELSE c.low_muted END, high_muted = CASE WHEN c.user_high = ? THEN ? ELSE c.high_muted END WHERE c.id = ? AND (c.user_low = ? OR c.user_high = ?)",
                me, muted, me, muted, id, me, me);
    }

    /** Removes what is there now from this person's view. The other person keeps theirs. */
    public void hide(long me, UUID id) {
        jdbc.update("""
                UPDATE public.messenger_conversations c SET
                  low_hidden_id = CASE WHEN c.user_low = ? THEN coalesce(c.last_message_id, 0) ELSE c.low_hidden_id END,
                  high_hidden_id = CASE WHEN c.user_high = ? THEN coalesce(c.last_message_id, 0) ELSE c.high_hidden_id END
                WHERE c.id = ? AND (c.user_low = ? OR c.user_high = ?)""", me, me, id, me, me);
    }

    // ── Messages ────────────────────────────────────────────
    /**
     * A message with everything shown on it: who sent it, what it answers, the emoji on it and its files. One statement, whatever the page size.
     * Needs the person asking at the head (their own reaction is marked).
     */
    static final String MESSAGE = ME + """
            SELECT m.id AS m_id, m.conversation_id AS m_conversation, m.sender_id AS m_sender, m.kind AS m_kind, m.body AS m_body, m.payload AS m_payload, m.client_ref AS m_ref, m.created_at AS m_at, m.deleted_at AS m_deleted,
                   i.id AS i_id, i.status AS i_status, i.mode AS i_mode, i.inviter_id AS i_inviter, i.invitee_id AS i_invitee, i.expires_at AS i_expires, i.room_code AS i_code,
                   coalesce(nullif(btrim(sp.display_name), ''), nullif(btrim(su.name), ''), 'Học viên') AS s_name,
                   sp.avatar_storage_key IS NOT NULL AND sp.avatar_storage_key <> '' AS s_avatar,
                   rp.id AS r_id, rp.sender_id AS r_sender, rp.kind AS r_kind, left(rp.body, 160) AS r_body, rp.deleted_at AS r_deleted, rp.payload -> 'att' AS r_att,
                   coalesce(nullif(btrim(rpp.display_name), ''), nullif(btrim(rpu.name), ''), 'Học viên') AS r_name,
                   (SELECT json_agg(json_build_object('e', x.emoji, 'n', x.n, 'me', x.me) ORDER BY x.first) FROM (
                      SELECT r.emoji, count(*) AS n, bool_or(r.user_id = (SELECT me FROM v)) AS me, min(r.created_at) AS first FROM public.messenger_reactions r WHERE r.message_id = m.id GROUP BY r.emoji) x) AS reactions,
                   (SELECT json_agg(json_build_object('id', a.id, 'kind', a.kind, 'name', a.file_name, 'mime', a.mime, 'size', a.size_bytes, 'w', a.width, 'h', a.height, 'thumb', a.thumb_key IS NOT NULL) ORDER BY a.position)
                      FROM public.messenger_attachments a WHERE a.message_id = m.id AND a.removed_at IS NULL) AS attachments
            FROM public.messenger_messages m
            JOIN public.users su ON su.id = m.sender_id
            LEFT JOIN public.user_profiles sp ON sp.user_id = m.sender_id
            LEFT JOIN public.messenger_arena_invites i ON i.message_id = m.id
            LEFT JOIN public.messenger_messages rp ON rp.id = m.reply_to
            LEFT JOIN public.users rpu ON rpu.id = rp.sender_id
            LEFT JOIN public.user_profiles rpp ON rpp.user_id = rp.sender_id""";

    /** The last message of a conversation in a list: enough for one line of preview. */
    private Message lastMessage(ResultSet rs) throws SQLException {
        UUID invite = rs.getObject("i_id", UUID.class);
        boolean deleted = rs.getTimestamp("m_deleted") != null;
        return new Message(rs.getLong("m_id"), rs.getObject("m_conversation", UUID.class), rs.getLong("m_sender"), rs.getString("m_kind"), rs.getString("m_body"),
                node(rs.getString("m_payload")), rs.getObject("m_ref", UUID.class), rs.getTimestamp("m_at").toInstant(),
                invite == null ? null : invite(rs, invite), null, null, null, List.of(), List.of(), deleted);
    }

    /** {@code floor}: messages up to this one are not this person's to see (removed from their list, or said before they joined), so a reply shows no words of them. */
    Message message(ResultSet rs, long floor) throws SQLException {
        UUID invite = rs.getObject("i_id", UUID.class);
        boolean deleted = rs.getTimestamp("m_deleted") != null;
        long sender = rs.getLong("m_sender");
        MessengerDtos.ReplyPreview reply = null;
        long replyId = rs.getLong("r_id");
        if (replyId > 0) {
            boolean gone = rs.getTimestamp("r_deleted") != null || replyId <= floor;
            JsonNode att = node(rs.getString("r_att"));
            String attachment = gone || att == null ? null : att.path("images").asInt(0) > 0 ? "IMAGE" : att.path("files").asInt(0) > 0 ? "FILE" : null;
            reply = new MessengerDtos.ReplyPreview(replyId, rs.getLong("r_sender"), shownOf(rs.getString("r_name")), rs.getString("r_kind"), gone ? "" : rs.getString("r_body"), gone, attachment);
        }
        List<MessengerDtos.Reaction> reactions = new java.util.ArrayList<>();
        JsonNode rx = node(rs.getString("reactions"));
        if (rx != null) for (JsonNode r : rx) reactions.add(new MessengerDtos.Reaction(r.path("e").asText(), r.path("n").asInt(), r.path("me").asBoolean()));
        List<MessengerDtos.Attachment> files = new java.util.ArrayList<>();
        JsonNode ax = node(rs.getString("attachments"));
        if (ax != null && !deleted) for (JsonNode a : ax) files.add(new MessengerDtos.Attachment(UUID.fromString(a.path("id").asText()), a.path("kind").asText(), a.path("name").asText(), a.path("mime").asText(), a.path("size").asInt(),
                a.path("w").isNumber() ? a.path("w").asInt() : null, a.path("h").isNumber() ? a.path("h").asInt() : null, a.path("thumb").asBoolean()));
        return new Message(rs.getLong("m_id"), rs.getObject("m_conversation", UUID.class), sender, rs.getString("m_kind"), rs.getString("m_body"),
                node(rs.getString("m_payload")), rs.getObject("m_ref", UUID.class), rs.getTimestamp("m_at").toInstant(),
                invite == null ? null : invite(rs, invite), shownOf(rs.getString("s_name")), rs.getBoolean("s_avatar") ? "/api/v1/users/" + sender + "/avatar" : null, reply, reactions, files, deleted);
    }

    private Invite invite(ResultSet rs, UUID id) throws SQLException {
        Timestamp expires = rs.getTimestamp("i_expires");
        String status = rs.getString("i_status");
        // A pending invitation past its time reads as expired wherever it is shown; nothing has to sweep it first.
        if ("PENDING".equals(status) && expires.toInstant().isBefore(Instant.now())) status = "EXPIRED";
        return new Invite(id, status, rs.getString("i_mode"), rs.getLong("i_inviter"), rs.getLong("i_invitee"), expires.toInstant(), rs.getString("i_code"));
    }

    JsonNode node(String text) {
        if (text == null) return null;
        try { return json.readTree(text); } catch (JsonProcessingException e) { return null; }
    }

    String text(JsonNode payload) {
        if (payload == null) return null;
        try { return json.writeValueAsString(payload); } catch (JsonProcessingException e) { throw new MessengerException(400, "INVALID_REQUEST"); }
    }

    /** Newest first. {@code after}: the floor (see {@link #message}); {@code downTo}: stop at this message (the one a reply answers), so the page reaches it. */
    public List<Message> messages(long me, UUID conversation, long before, long after, int limit, String query, long downTo) {
        StringBuilder sql = new StringBuilder(MESSAGE).append(" WHERE m.conversation_id = ? AND m.id > ?");
        List<Object> args = new java.util.ArrayList<>(List.of(me, conversation, after));
        if (before > 0) { sql.append(" AND m.id < ?"); args.add(before); }
        if (downTo > 0) { sql.append(" AND m.id >= ?"); args.add(downTo); }
        if (query != null && !query.isBlank()) {
            sql.append(" AND m.deleted_at IS NULL AND m.kind = 'TEXT' AND m.body ILIKE ?");
            args.add("%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
        }
        sql.append(" ORDER BY m.id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> message(rs, after), args.toArray());
    }

    public record Markers(long myRead, long theirRead, long theirDelivered) {}

    public Markers markers(long me, UUID id) {
        return jdbc.query("""
                SELECT CASE WHEN c.user_low = ? THEN c.low_read_id ELSE c.high_read_id END,
                       CASE WHEN EXISTS (SELECT 1 FROM public.messenger_restrictions x WHERE x.restricted_id = ? AND x.user_id = CASE WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END) THEN 0
                            WHEN c.user_low = ? THEN c.high_read_id ELSE c.low_read_id END,
                       CASE WHEN c.user_low = ? THEN c.high_delivered_id ELSE c.low_delivered_id END
                FROM public.messenger_conversations c WHERE c.id = ? AND (c.user_low = ? OR c.user_high = ?)""",
                (rs, n) -> new Markers(rs.getLong(1), rs.getLong(2), rs.getLong(3)), me, me, me, me, me, id, me, me).stream().findFirst().orElse(new Markers(0, 0, 0));
    }

    public Optional<Message> messageByRef(long sender, UUID ref) {
        return jdbc.query(MESSAGE + " WHERE m.sender_id = ? AND m.client_ref = ?", (rs, n) -> message(rs, 0), sender, sender, ref).stream().findFirst();
    }

    public Optional<Message> messageById(long me, long id) {
        return jdbc.query(MESSAGE + " WHERE m.id = ?", (rs, n) -> message(rs, 0), me, id).stream().findFirst();
    }

    public record Inserted(long id, Instant at) {}

    /** The message and the conversation row move together, in one statement. A second send with the same reference inserts nothing and answers empty. */
    public Optional<Inserted> insert(UUID conversation, long sender, long other, String kind, String body, JsonNode payload, UUID ref, boolean delivered) {
        return insert(conversation, sender, other, kind, body, payload, ref, delivered, null);
    }

    public Optional<Inserted> insert(UUID conversation, long sender, long other, String kind, String body, JsonNode payload, UUID ref, boolean delivered, Long replyTo) {
        return jdbc.query("""
                WITH m AS (
                  INSERT INTO public.messenger_messages (conversation_id, sender_id, kind, body, payload, client_ref, reply_to)
                  VALUES (?, ?, ?, ?, ?::jsonb, ?, ?) ON CONFLICT (sender_id, client_ref) DO NOTHING RETURNING id, created_at
                ), c AS (
                  UPDATE public.messenger_conversations x
                  SET last_message_id = m.id, last_message_at = m.created_at,
                      low_read_id = CASE WHEN x.user_low = ? THEN m.id ELSE x.low_read_id END,
                      high_read_id = CASE WHEN x.user_high = ? THEN m.id ELSE x.high_read_id END,
                      low_delivered_id = CASE WHEN x.user_low = ? AND ? THEN m.id ELSE x.low_delivered_id END,
                      high_delivered_id = CASE WHEN x.user_high = ? AND ? THEN m.id ELSE x.high_delivered_id END
                  FROM m WHERE x.id = ? RETURNING m.id, m.created_at
                )
                SELECT id, created_at FROM c""", (rs, n) -> new Inserted(rs.getLong(1), rs.getTimestamp(2).toInstant()), conversation, sender, kind, body, text(payload), ref, replyTo, sender, sender, other, delivered, other, delivered, conversation).stream().findFirst();
    }

    // ── Arena invitations ───────────────────────────────────
    public record InviteRow(UUID id, UUID conversation, long inviter, long invitee, String mode, String status, String code, Instant expires, UUID targetRoom) {}

    private InviteRow inviteRow(ResultSet rs, int n) throws SQLException {
        return new InviteRow(rs.getObject("id", UUID.class), rs.getObject("conversation_id", UUID.class), rs.getLong("inviter_id"), rs.getLong("invitee_id"), rs.getString("mode"), rs.getString("status"), rs.getString("room_code"), rs.getTimestamp("expires_at").toInstant(),rs.getObject("target_room_id",UUID.class));
    }

    public Optional<InviteRow> inviteFor(long me, UUID id) {
        return jdbc.query("SELECT * FROM public.messenger_arena_invites WHERE id = ? AND (inviter_id = ? OR invitee_id = ?)", this::inviteRow, id, me, me).stream().findFirst();
    }

    public Optional<InviteRow> pendingIn(UUID conversation) {
        return jdbc.query("SELECT * FROM public.messenger_arena_invites WHERE conversation_id = ? AND status = 'PENDING'", this::inviteRow, conversation).stream().findFirst();
    }

    /** An old pending invitation past its time gives its place up for a new one. */
    public void retireExpired(UUID conversation) {
        jdbc.update("UPDATE public.messenger_arena_invites SET status = 'CANCELLED', responded_at = now() WHERE conversation_id = ? AND status = 'PENDING' AND expires_at < now()", conversation);
    }

    public List<InviteRow> roomInvites(long me, UUID room) {
        return jdbc.query("SELECT * FROM public.messenger_arena_invites WHERE inviter_id=? AND target_room_id=? AND expires_at>now() ORDER BY expires_at DESC LIMIT 64",this::inviteRow,me,room);
    }
    public boolean insertInvite(UUID id, UUID conversation, long message, long inviter, long invitee, String mode, Instant expires, UUID targetRoom) {
        try {
            jdbc.update("INSERT INTO public.messenger_arena_invites (id, conversation_id, message_id, inviter_id, invitee_id, mode, expires_at, target_room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    id, conversation, message, inviter, invitee, mode, Timestamp.from(expires),targetRoom);
            return true;
        } catch (DuplicateKeyException e) {
            return false;
        }
    }

    /** Only a pending invitation changes, once: the answer that wins is the one this row took. */
    public boolean respond(UUID id, String status, String code) {
        return jdbc.update("UPDATE public.messenger_arena_invites SET status = ?, room_code = ?, responded_at = now() WHERE id = ? AND status = 'PENDING' AND expires_at > now()", status, code, id) == 1;
    }

    // ── What may be shared: SYSTEM content only, so the other person can open it ──
    public Optional<String> systemReadingTitle(long id) {
        return jdbc.query("SELECT title FROM public.reading_materials WHERE id = ? AND is_system = TRUE AND owner_user_id IS NULL", (rs, n) -> rs.getString(1), id).stream().findFirst();
    }

    public Optional<String> systemDeckTitle(long id) {
        return jdbc.query("SELECT title FROM public.vocab_decks WHERE id = ? AND is_system = TRUE", (rs, n) -> rs.getString(1), id).stream().findFirst();
    }
}
