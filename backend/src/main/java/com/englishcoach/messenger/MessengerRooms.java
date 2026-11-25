package com.englishcoach.messenger;

import com.englishcoach.messenger.MessengerDtos.Message;
import com.englishcoach.messenger.MessengerRepository.Inserted;
import com.englishcoach.messenger.MessengerRepository.PersonRow;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * What V121 added to the Messenger: groups and their people, a person's own choices for a conversation, reactions, unsending, attachments (the rows; the bytes are
 * {@link MessengerFiles}) and restricting. Like {@link MessengerRepository}, every statement names the person asking: a group someone is not in does not exist for them.
 */
@Repository
public class MessengerRooms {
    private final JdbcTemplate jdbc;
    private final MessengerRepository messages;

    public MessengerRooms(JdbcTemplate jdbc, MessengerRepository messages) {
        this.jdbc = jdbc;
        this.messages = messages;
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp t = rs.getTimestamp(column);
        return t == null ? null : t.toInstant();
    }
    private static String shownOf(String shown) { return shown == null || shown.contains("@") ? "Học viên" : shown; }
    private static final String SHOWN = "coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(u.name), ''), 'Học viên')";

    // ── Groups ──────────────────────────────────────────────
    /** A group seen by one of its people. {@code floor}: messages up to here are not theirs to read (said before they joined, or removed from their list). */
    public record GroupSide(UUID id, long me, String role, long floor, long readId, String title, String theme, boolean avatar, int avatarVersion, Instant mutedUntil, boolean pinned, boolean archived, boolean markedUnread,
                            int memberCount, long lastMessageId, String myName, String myPrincipal, boolean restricted) {
        boolean manages() { return "OWNER".equals(role) || "ADMIN".equals(role); }
    }

    public Optional<GroupSide> member(long me, UUID id) {
        return jdbc.query("""
                SELECT c.id, g.role, GREATEST(g.since_id, g.hidden_id) AS floor, g.read_id, c.title, c.theme, c.avatar_key IS NOT NULL AS has_avatar, c.avatar_version, g.muted_until, g.pinned_at,
                       g.archived_id >= coalesce(c.last_message_id, 0) AND g.archived_id > 0 AS archived, g.marked_unread, coalesce(c.last_message_id, 0) AS last_id,
                       (SELECT count(*) FROM public.messenger_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS members,
                       u.email, """ + SHOWN + """
                        AS shown,
                       EXISTS (SELECT 1 FROM public.community_user_restrictions r WHERE r.target_user_id = u.id AND r.restriction_type IN ('SUSPEND_COMMUNITY', 'READ_ONLY') AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())) AS restricted
                FROM public.messenger_members g JOIN public.messenger_conversations c ON c.id = g.conversation_id AND c.kind = 'GROUP'
                JOIN public.users u ON u.id = g.user_id LEFT JOIN public.user_profiles p ON p.user_id = u.id
                WHERE g.conversation_id = ? AND g.user_id = ? AND g.left_at IS NULL AND u.account_status = 'ACTIVE'""", (rs, n) -> {
                    Instant muted = instant(rs, "muted_until");
                    return new GroupSide(rs.getObject("id", UUID.class), me, rs.getString("role"), rs.getLong("floor"), rs.getLong("read_id"), rs.getString("title"), rs.getString("theme"), rs.getBoolean("has_avatar"), rs.getInt("avatar_version"),
                            muted != null && muted.isAfter(Instant.now()) ? muted : null, rs.getTimestamp("pinned_at") != null, rs.getBoolean("archived"), rs.getBoolean("marked_unread"), rs.getInt("members"), rs.getLong("last_id"),
                            shownOf(rs.getString("shown")), rs.getString("email"), rs.getBoolean("restricted"));
                }, id, me).stream().findFirst();
    }

    /** One row of the Chats list for a group, with its last message and unread count (stopping at 100). */
    public record GroupRow(UUID id, String title, String theme, boolean avatar, int avatarVersion, String role, int members, Message last, int unread, long readId, Instant mutedUntil, boolean pinned, boolean archived, boolean markedUnread, Instant at) {}

    public List<GroupRow> groups(long me, Instant before, int limit, String scope, UUID only) {
        StringBuilder sql = new StringBuilder("""
                SELECT c.id AS conversation, c.title, c.theme, c.avatar_key IS NOT NULL AS has_avatar, c.avatar_version, g.role, g.read_id, g.muted_until, g.pinned_at, g.marked_unread, c.last_message_at,
                       g.archived_id >= coalesce(c.last_message_id, 0) AND g.archived_id > 0 AS archived,
                       (SELECT count(*) FROM public.messenger_members x WHERE x.conversation_id = c.id AND x.left_at IS NULL) AS members,
                       (SELECT count(*) FROM (SELECT 1 FROM public.messenger_messages um WHERE um.conversation_id = c.id AND um.sender_id <> g.user_id AND um.id > GREATEST(g.read_id, g.hidden_id, g.since_id) LIMIT 100) n) AS unread,
                       m.id AS m_id, m.conversation_id AS m_conversation, m.sender_id AS m_sender, m.kind AS m_kind, m.body AS m_body, m.payload AS m_payload, m.client_ref AS m_ref, m.created_at AS m_at, m.deleted_at AS m_deleted,
                       coalesce(nullif(btrim(sp.display_name), ''), nullif(btrim(su.name), ''), 'Học viên') AS s_name
                FROM public.messenger_members g JOIN public.messenger_conversations c ON c.id = g.conversation_id AND c.kind = 'GROUP'
                LEFT JOIN public.messenger_messages m ON m.id = c.last_message_id AND m.id > GREATEST(g.since_id, g.hidden_id)
                LEFT JOIN public.users su ON su.id = m.sender_id LEFT JOIN public.user_profiles sp ON sp.user_id = m.sender_id
                WHERE g.user_id = ? AND g.left_at IS NULL""");
        List<Object> args = new ArrayList<>(List.of(me));
        String archived = "(g.archived_id >= coalesce(c.last_message_id, 0) AND g.archived_id > 0)";
        if (only != null) { sql.append(" AND c.id = ?"); args.add(only); }
        else if ("ARCHIVED".equals(scope)) sql.append(" AND ").append(archived);
        else sql.append(" AND NOT ").append(archived).append(" AND coalesce(c.last_message_id, 0) >= g.hidden_id");
        if (before != null) { sql.append(" AND g.pinned_at IS NULL AND c.last_message_at < ?"); args.add(Timestamp.from(before)); }
        sql.append(" ORDER BY (g.pinned_at IS NOT NULL) DESC, c.last_message_at DESC NULLS LAST LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> {
            long mid = rs.getLong("m_id");
            Message last = mid == 0 ? null : new Message(mid, rs.getObject("m_conversation", UUID.class), rs.getLong("m_sender"), rs.getString("m_kind"), rs.getString("m_body"), messages.node(rs.getString("m_payload")),
                    rs.getObject("m_ref", UUID.class), rs.getTimestamp("m_at").toInstant(), null, shownOf(rs.getString("s_name")), null, null, List.of(), List.of(), rs.getTimestamp("m_deleted") != null);
            Instant muted = instant(rs, "muted_until");
            return new GroupRow(rs.getObject("conversation", UUID.class), rs.getString("title"), rs.getString("theme"), rs.getBoolean("has_avatar"), rs.getInt("avatar_version"), rs.getString("role"), rs.getInt("members"), last,
                    rs.getInt("unread"), rs.getLong("read_id"), muted != null && muted.isAfter(Instant.now()) ? muted : null, rs.getTimestamp("pinned_at") != null, rs.getBoolean("archived"), rs.getBoolean("marked_unread"), instant(rs, "last_message_at"));
        }, args.toArray());
    }

    public void createGroup(UUID id, long owner, String title, Collection<Long> others) {
        jdbc.update("INSERT INTO public.messenger_conversations (id, kind, title, created_by, last_message_at) VALUES (?, 'GROUP', ?, ?, now())", id, title, owner);
        jdbc.update("INSERT INTO public.messenger_members (conversation_id, user_id, role, added_by) VALUES (?, ?, 'OWNER', ?)", id, owner, owner);
        for (long other : others) jdbc.update("INSERT INTO public.messenger_members (conversation_id, user_id, role, added_by) VALUES (?, ?, 'MEMBER', ?)", id, other, owner);
    }

    /** Joins now, or comes back: reads from the message that is the last one at this moment. False: already there. */
    public boolean addMember(UUID id, long user, long by) {
        return jdbc.update("""
                INSERT INTO public.messenger_members (conversation_id, user_id, role, added_by, since_id)
                SELECT c.id, ?, 'MEMBER', ?, coalesce(c.last_message_id, 0) FROM public.messenger_conversations c WHERE c.id = ? AND c.kind = 'GROUP'
                ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'MEMBER', added_by = EXCLUDED.added_by, joined_at = now(), since_id = EXCLUDED.since_id,
                    read_id = EXCLUDED.since_id, hidden_id = 0, archived_id = 0, pinned_at = NULL, marked_unread = FALSE
                WHERE public.messenger_members.left_at IS NOT NULL""", user, by, id) == 1;
    }

    public boolean leave(UUID id, long user) {
        return jdbc.update("UPDATE public.messenger_members SET left_at = now(), pinned_at = NULL WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", id, user) == 1;
    }

    public boolean setRole(UUID id, long user, String role) {
        return jdbc.update("UPDATE public.messenger_members SET role = ? WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", role, id, user) == 1;
    }

    /** The person a group passes to when its owner leaves: an admin first, then whoever has been there longest. */
    public Optional<Long> heir(UUID id) {
        return jdbc.query("SELECT user_id FROM public.messenger_members WHERE conversation_id = ? AND left_at IS NULL ORDER BY (role = 'ADMIN') DESC, joined_at, user_id LIMIT 1", (rs, n) -> rs.getLong(1), id).stream().findFirst();
    }

    public Optional<String> roleOf(UUID id, long user) {
        return jdbc.query("SELECT role FROM public.messenger_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", (rs, n) -> rs.getString(1), id, user).stream().findFirst();
    }

    public int memberCount(UUID id) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.messenger_members WHERE conversation_id = ? AND left_at IS NULL", Integer.class, id);
        return n == null ? 0 : n;
    }

    public int groupsOf(long user) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.messenger_members WHERE user_id = ? AND left_at IS NULL", Integer.class, user);
        return n == null ? 0 : n;
    }

    public void rename(UUID id, String title) { jdbc.update("UPDATE public.messenger_conversations SET title = ? WHERE id = ? AND kind = 'GROUP'", title, id); }
    public void setTheme(UUID id, String theme) { jdbc.update("UPDATE public.messenger_conversations SET theme = ? WHERE id = ?", theme, id); }
    public Optional<String> avatarKey(UUID id) { return jdbc.query("SELECT avatar_key FROM public.messenger_conversations WHERE id = ? AND kind = 'GROUP'", (rs, n) -> rs.getString(1), id).stream().filter(java.util.Objects::nonNull).findFirst(); }
    public void setAvatar(UUID id, String key) { jdbc.update("UPDATE public.messenger_conversations SET avatar_key = ?, avatar_version = avatar_version + 1 WHERE id = ? AND kind = 'GROUP'", key, id); }

    /** {@code quiet}: this person blocked or restricted the sender, so the message reaches them without a card. */
    /** {@code quiet}: this person blocked or restricted the sender, so the message reaches them without a card. {@code muted}: they muted this group. */
    public record Reach(long user, String principal, boolean quiet, boolean muted) {
        public Reach(long user, String principal, boolean quiet) { this(user, principal, quiet, false); }
    }

    /** Everyone in the group now: who a typing mark or a change is told to. */
    public List<Reach> reach(UUID id) { return reach(id, 0); }

    /** Everyone in the group now, for a message from {@code sender}. */
    public List<Reach> reach(UUID id, long sender) {
        return jdbc.query("""
                SELECT u.id, u.email,
                       EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE b.blocker_id = u.id AND b.blocked_id = ?) OR EXISTS (SELECT 1 FROM public.messenger_restrictions r WHERE r.user_id = u.id AND r.restricted_id = ?),
                       coalesce(g.muted_until > now(), FALSE)
                FROM public.messenger_members g JOIN public.users u ON u.id = g.user_id WHERE g.conversation_id = ? AND g.left_at IS NULL AND u.account_status = 'ACTIVE'""",
                (rs, n) -> new Reach(rs.getLong(1), rs.getString(2), rs.getBoolean(3), rs.getBoolean(4)), sender, sender, id);
    }

    public record MemberRow(PersonRow person, String role, Instant joined) {}

    public List<MemberRow> members(long me, UUID id) {
        return jdbc.query(MessengerRepository.ME + """
                SELECT u.id, u.email, d.username, g.role, g.joined_at, """ + SHOWN + """
                        AS shown, p.avatar_storage_key IS NOT NULL AND p.avatar_storage_key <> '' AS has_avatar,
                       CASE WHEN u.id = (SELECT me FROM v) THEN 'SELF'
                            WHEN EXISTS (SELECT 1 FROM public.messenger_blocks b WHERE b.blocker_id = (SELECT me FROM v) AND b.blocked_id = u.id) THEN 'BLOCKED'
                            WHEN mine.id IS NOT NULL AND theirs.id IS NOT NULL THEN 'FRIEND' WHEN theirs.id IS NOT NULL THEN 'INCOMING' WHEN mine.id IS NOT NULL THEN 'OUTGOING' ELSE 'NONE' END AS relation"""
                + MessengerRepository.activity("u") + """

                FROM public.messenger_members g JOIN public.users u ON u.id = g.user_id
                LEFT JOIN public.user_profiles p ON p.user_id = u.id LEFT JOIN public.messenger_directory d ON d.user_id = u.id
                LEFT JOIN public.community_follows mine ON mine.follower_user_id = (SELECT me FROM v) AND mine.following_user_id = u.id
                LEFT JOIN public.community_follows theirs ON theirs.follower_user_id = u.id AND theirs.following_user_id = (SELECT me FROM v)
                WHERE g.conversation_id = ? AND g.left_at IS NULL AND u.account_status = 'ACTIVE'
                ORDER BY (g.role = 'OWNER') DESC, (g.role = 'ADMIN') DESC, shown, u.id""",
                (rs, n) -> new MemberRow(messages.personSeen(rs, rs.getString("relation")), rs.getString("role"), instant(rs, "joined_at")), me, id);
    }

    /** Of these people, those the person may put in a group: their friends, with no block either way. */
    public List<Long> addable(long me, Collection<Long> candidates) {
        if (candidates.isEmpty()) return List.of();
        return jdbc.query("""
                SELECT u.id FROM public.users u
                JOIN public.community_follows a ON a.follower_user_id = ? AND a.following_user_id = u.id
                JOIN public.community_follows b ON b.follower_user_id = u.id AND b.following_user_id = ?
                WHERE u.id = ANY (?) AND u.account_status = 'ACTIVE'
                  AND NOT EXISTS (SELECT 1 FROM public.messenger_blocks z WHERE (z.blocker_id = ? AND z.blocked_id = u.id) OR (z.blocker_id = u.id AND z.blocked_id = ?))""",
                ps -> { ps.setLong(1, me); ps.setLong(2, me); ps.setArray(3, ps.getConnection().createArrayOf("bigint", candidates.toArray())); ps.setLong(4, me); ps.setLong(5, me); },
                (rs, n) -> rs.getLong(1));
    }

    /** The message and the group's row move together; the sender has read what they wrote. A second send with the same reference inserts nothing. */
    public Optional<Inserted> insertGroup(UUID conversation, long sender, String kind, String body, JsonNode payload, UUID ref, Long replyTo) {
        return jdbc.query("""
                WITH m AS (
                  INSERT INTO public.messenger_messages (conversation_id, sender_id, kind, body, payload, client_ref, reply_to)
                  VALUES (?, ?, ?, ?, ?::jsonb, ?, ?) ON CONFLICT (sender_id, client_ref) DO NOTHING RETURNING id, created_at
                ), c AS (
                  UPDATE public.messenger_conversations x SET last_message_id = m.id, last_message_at = m.created_at FROM m WHERE x.id = ? RETURNING x.id
                ), r AS (
                  UPDATE public.messenger_members g SET read_id = m.id FROM m WHERE g.conversation_id = ? AND g.user_id = ? RETURNING g.user_id
                )
                SELECT m.id, m.created_at FROM m LEFT JOIN c ON TRUE LEFT JOIN r ON TRUE""",
                (rs, n) -> new Inserted(rs.getLong(1), rs.getTimestamp(2).toInstant()), conversation, sender, kind, body, messages.text(payload), ref, replyTo, conversation, conversation, sender).stream().findFirst();
    }

    public void markGroupRead(long me, UUID id, long upTo) {
        jdbc.update("""
                UPDATE public.messenger_members g SET read_id = GREATEST(g.read_id, ?), marked_unread = FALSE
                FROM public.messenger_conversations c WHERE c.id = g.conversation_id AND g.conversation_id = ? AND g.user_id = ? AND g.left_at IS NULL AND ? <= coalesce(c.last_message_id, 0)""", upTo, id, me, upTo);
    }

    // ── A person's own choices ──────────────────────────────
    /** {@code column} is one of the four names below, never anything a request carries. */
    private void pref(boolean group, UUID id, long me, String column, Object value) {
        if (!List.of("muted_until", "pinned_at", "archived_id", "marked_unread").contains(column)) throw new IllegalArgumentException(column);
        if (group) jdbc.update("UPDATE public.messenger_members SET " + column + " = ? WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", value, id, me);
        else jdbc.update("INSERT INTO public.messenger_prefs (conversation_id, user_id, " + column + ") VALUES (?, ?, ?) ON CONFLICT (conversation_id, user_id) DO UPDATE SET " + column + " = EXCLUDED." + column, id, me, value);
    }

    public void mute(boolean group, UUID id, long me, Instant until) { pref(group, id, me, "muted_until", until == null ? null : Timestamp.from(until)); }
    public void pin(boolean group, UUID id, long me, boolean pinned) { pref(group, id, me, "pinned_at", pinned ? Timestamp.from(Instant.now()) : null); }
    public void archive(boolean group, UUID id, long me, long upTo) { pref(group, id, me, "archived_id", upTo); }
    public void markUnread(boolean group, UUID id, long me, boolean unread) { pref(group, id, me, "marked_unread", unread); }
    public void hideGroup(UUID id, long me) {
        jdbc.update("UPDATE public.messenger_members g SET hidden_id = coalesce(c.last_message_id, 0) FROM public.messenger_conversations c WHERE c.id = g.conversation_id AND g.conversation_id = ? AND g.user_id = ?", id, me);
    }

    public int pinnedCount(long me) {
        Integer n = jdbc.queryForObject("SELECT (SELECT count(*) FROM public.messenger_prefs WHERE user_id = ? AND pinned_at IS NOT NULL) + (SELECT count(*) FROM public.messenger_members WHERE user_id = ? AND left_at IS NULL AND pinned_at IS NOT NULL)", Integer.class, me, me);
        return n == null ? 0 : n;
    }

    // ── Restricting ─────────────────────────────────────────
    public void restrict(long me, long other) { jdbc.update("INSERT INTO public.messenger_restrictions (user_id, restricted_id) VALUES (?, ?) ON CONFLICT DO NOTHING", me, other); }
    public void unrestrict(long me, long other) { jdbc.update("DELETE FROM public.messenger_restrictions WHERE user_id = ? AND restricted_id = ?", me, other); }
    public boolean restricts(long who, long whom) {
        Boolean yes = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM public.messenger_restrictions WHERE user_id = ? AND restricted_id = ?)", Boolean.class, who, whom);
        return Boolean.TRUE.equals(yes);
    }

    // ── One message, for something done to it ───────────────
    public record Target(long id, UUID conversation, long sender, String kind, boolean deleted) {}

    public Optional<Target> target(long message) {
        return jdbc.query("SELECT id, conversation_id, sender_id, kind, deleted_at IS NOT NULL FROM public.messenger_messages WHERE id = ?", (rs, n) -> new Target(rs.getLong(1), rs.getObject(2, UUID.class), rs.getLong(3), rs.getString(4), rs.getBoolean(5)), message).stream().findFirst();
    }

    /** One emoji per person per message: a new one replaces the old one. */
    public void react(long message, long user, String emoji) {
        jdbc.update("INSERT INTO public.messenger_reactions (message_id, user_id, emoji) VALUES (?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()", message, user, emoji);
    }
    public boolean unreact(long message, long user) { return jdbc.update("DELETE FROM public.messenger_reactions WHERE message_id = ? AND user_id = ?", message, user) == 1; }

    public record Reactor(String emoji, long id, String name, boolean avatar) {}
    public List<Reactor> reactors(long message) {
        return jdbc.query("SELECT r.emoji, u.id, " + SHOWN + " AS shown, p.avatar_storage_key IS NOT NULL AND p.avatar_storage_key <> '' AS has_avatar FROM public.messenger_reactions r JOIN public.users u ON u.id = r.user_id"
                + " LEFT JOIN public.user_profiles p ON p.user_id = u.id WHERE r.message_id = ? ORDER BY r.created_at LIMIT 200", (rs, n) -> new Reactor(rs.getString(1), rs.getLong(2), shownOf(rs.getString(3)), rs.getBoolean(4)), message);
    }

    /** The words and the files go; the row stays, so the conversation keeps its order and replies keep their place. Only the sender's own text message, once. */
    public boolean unsend(long message, long sender) {
        return jdbc.update("UPDATE public.messenger_messages SET body = '', payload = NULL, deleted_at = now() WHERE id = ? AND sender_id = ? AND deleted_at IS NULL AND kind = 'TEXT'", message, sender) == 1;
    }

    // ── Attachments (rows) ──────────────────────────────────
    public record FileRow(UUID id, long owner, UUID conversation, Long message, String kind, String name, String mime, int size, Integer width, Integer height, String key, String thumbKey) {}

    private static FileRow fileRow(ResultSet rs, int n) throws SQLException {
        long message = rs.getLong("message_id");
        Long messageId = rs.wasNull() ? null : message;
        int w = rs.getInt("width"); Integer width = rs.wasNull() ? null : w;
        int h = rs.getInt("height"); Integer height = rs.wasNull() ? null : h;
        return new FileRow(rs.getObject("id", UUID.class), rs.getLong("owner_id"), rs.getObject("conversation_id", UUID.class), messageId, rs.getString("kind"), rs.getString("file_name"), rs.getString("mime"), rs.getInt("size_bytes"), width, height,
                rs.getString("storage_key"), rs.getString("thumb_key"));
    }

    public void insertFile(FileRow f) {
        jdbc.update("INSERT INTO public.messenger_attachments (id, owner_id, conversation_id, kind, file_name, mime, size_bytes, width, height, storage_key, thumb_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                f.id(), f.owner(), f.conversation(), f.kind(), f.name(), f.mime(), f.size(), f.width(), f.height(), f.key(), f.thumbKey());
    }

    /** The files waiting in this person's composer for this conversation, among those named. */
    public List<FileRow> pending(long owner, UUID conversation, Collection<UUID> ids) {
        if (ids.isEmpty()) return List.of();
        return jdbc.query("SELECT * FROM public.messenger_attachments WHERE owner_id = ? AND conversation_id = ? AND message_id IS NULL AND removed_at IS NULL AND id = ANY (?)",
                ps -> { ps.setLong(1, owner); ps.setObject(2, conversation); ps.setArray(3, ps.getConnection().createArrayOf("uuid", ids.toArray())); }, MessengerRooms::fileRow);
    }

    public int attach(long owner, UUID conversation, long message, List<UUID> ids) {
        int n = 0;
        for (int i = 0; i < ids.size(); i++) n += jdbc.update("UPDATE public.messenger_attachments SET message_id = ?, position = ? WHERE id = ? AND owner_id = ? AND conversation_id = ? AND message_id IS NULL AND removed_at IS NULL", message, i, ids.get(i), owner, conversation);
        return n;
    }

    public Optional<FileRow> file(UUID id) {
        return jdbc.query("SELECT * FROM public.messenger_attachments WHERE id = ? AND removed_at IS NULL", MessengerRooms::fileRow, id).stream().findFirst();
    }

    /** A file taken back from the composer before sending: only its owner, only while it has no message. */
    public Optional<FileRow> discard(UUID id, long owner) {
        return jdbc.query("UPDATE public.messenger_attachments SET removed_at = now() WHERE id = ? AND owner_id = ? AND message_id IS NULL AND removed_at IS NULL RETURNING *", MessengerRooms::fileRow, id, owner).stream().findFirst();
    }

    public List<FileRow> removeOf(long message) {
        return jdbc.query("UPDATE public.messenger_attachments SET removed_at = now() WHERE message_id = ? AND removed_at IS NULL RETURNING *", MessengerRooms::fileRow, message);
    }

    /** Files that waited in a composer for over an hour and were never sent. */
    public List<FileRow> abandon(int limit) {
        return jdbc.query("""
                UPDATE public.messenger_attachments SET removed_at = now() WHERE id IN (
                  SELECT id FROM public.messenger_attachments WHERE message_id IS NULL AND removed_at IS NULL AND created_at < now() - interval '1 hour' ORDER BY created_at LIMIT ?) RETURNING *""", MessengerRooms::fileRow, limit);
    }

    public record Usage(long live, long month, int waiting) {}

    /** What this person keeps on the server now, what they added in thirty days, and how many files wait unsent. */
    public Usage usage(long owner) {
        return jdbc.queryForObject("""
                SELECT coalesce(sum(size_bytes), 0), coalesce(sum(size_bytes) FILTER (WHERE created_at > now() - interval '30 days'), 0), count(*) FILTER (WHERE message_id IS NULL)
                FROM public.messenger_attachments WHERE owner_id = ? AND removed_at IS NULL""", (rs, n) -> new Usage(rs.getLong(1), rs.getLong(2), rs.getInt(3)), owner);
    }

    /** Pictures and files of a conversation, newest first, from the floor of the person asking. */
    public List<MessengerDtos.Attachment> shared(UUID conversation, long floor, String kind, int limit) {
        return jdbc.query("SELECT * FROM public.messenger_attachments WHERE conversation_id = ? AND message_id > ? AND removed_at IS NULL AND kind = ? ORDER BY created_at DESC LIMIT ?",
                (rs, n) -> { FileRow f = fileRow(rs, n); return new MessengerDtos.Attachment(f.id(), f.kind(), f.name(), f.mime(), f.size(), f.width(), f.height(), f.thumbKey() != null); }, conversation, floor, kind, limit);
    }
}
