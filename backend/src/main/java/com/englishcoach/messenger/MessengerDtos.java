package com.englishcoach.messenger;

import com.fasterxml.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** What the Messenger says over HTTP and over the private STOMP queue. Never an e-mail address, never another person's settings. */
public final class MessengerDtos {
    private MessengerDtos() {}

    /**
     * Relation from the side of the person asking: FRIEND, INCOMING (they asked), OUTGOING (I asked), BLOCKED, NONE.
     * {@code online} and {@code lastActiveAt} are told only to someone allowed to see this person's activity (connected, neither side
     * hiding their own, no block, not restricted by them); last active is never older than seven days.
     */
    public record Person(long id, String name, String avatarUrl, boolean online, String username, String relation, Instant lastActiveAt) {
        public Person(long id, String name, String avatarUrl, boolean online, String username, String relation) { this(id, name, avatarUrl, online, username, relation, null); }
    }

    /** Friends follow each other in Community. A request is a follow not yet returned. */
    public record People(List<Person> friends, List<Person> incoming, List<Person> outgoing, List<Person> blocked, boolean moreFriends, List<Person> restricted, Instant now) {
        public People(List<Person> friends, List<Person> incoming, List<Person> outgoing, List<Person> blocked, boolean moreFriends) { this(friends, incoming, outgoing, blocked, moreFriends, List.of(), Instant.now()); }
    }

    public record PersonPage(List<Person> items, String next) {}

    /** The card shown when someone is opened. {@code refused}: why a message cannot go now; null when it can. */
    public record Profile(Person person, boolean self, String refused, boolean connected, UUID conversationId, long followers, long following, int streakDays, String cefrLevel, boolean premium, boolean restricted) {}

    public record Me(String username, String messagePolicy, boolean discoverable, boolean showActivity) {}
    public record MeRequest(String username, String messagePolicy, Boolean discoverable, Boolean showActivity) {
        public MeRequest(String username, String messagePolicy, Boolean discoverable) { this(username, messagePolicy, discoverable, null); }
    }

    public record Invite(UUID id, String status, String mode, long inviterId, long inviteeId, Instant expiresAt, String code) {
        Invite closed() { return new Invite(id, "CLOSED", mode, inviterId, inviteeId, expiresAt, null); }
    }

    /** The message a reply answers, as much as is needed to show it above the reply. {@code deleted}: it was unsent, its words are gone. */
    public record ReplyPreview(long id, long senderId, String senderName, String kind, String text, boolean deleted, String attachment) {}

    /** One emoji on a message: how many people chose it, and whether the person asking is one of them. */
    public record Reaction(String emoji, int count, boolean mine) {}

    /** A file of a message. The bytes are read from /messenger/attachments/{id} (and /thumb for a picture), only by people of the conversation. */
    public record Attachment(UUID id, String kind, String name, String mime, int size, Integer width, Integer height, boolean thumb) {}

    public record Message(long id, UUID conversationId, long senderId, String kind, String body, JsonNode payload, UUID ref, Instant at, Invite invite,
                          String senderName, String senderAvatarUrl, ReplyPreview replyTo, List<Reaction> reactions, List<Attachment> attachments, boolean deleted) {
        public Message(long id, UUID conversationId, long senderId, String kind, String body, JsonNode payload, UUID ref, Instant at, Invite invite) {
            this(id, conversationId, senderId, kind, body, payload, ref, at, invite, null, null, null, List.of(), List.of(), false);
        }
        Message with(Invite other) { return new Message(id, conversationId, senderId, kind, body, payload, ref, at, other, senderName, senderAvatarUrl, replyTo, reactions, attachments, deleted); }
    }

    /**
     * {@code kind}: DIRECT (then {@code other} is the person) or GROUP (then {@code title}, {@code memberCount}, {@code role}).
     * {@code connected}: friends, or a request that was accepted. {@code request}: MINE while my first messages wait, THEIRS while theirs wait for me.
     * {@code mutedUntil}: null = not muted; a far date = until turned back on. {@code restricted}: I restricted this person (the conversation waits aside).
     */
    public record Conversation(UUID id, Person other, Message last, int unread, long myRead, long theirRead, long theirDelivered,
                               boolean muted, String refused, boolean connected, String request,
                               String kind, String title, String avatarUrl, int memberCount, String role, String theme,
                               boolean pinned, boolean archived, Instant mutedUntil, boolean restricted, boolean markedUnread) {}

    public record ConversationPage(List<Conversation> items, boolean more, Instant now) {}

    public record MessagePage(List<Message> messages, boolean more, long myRead, long theirRead, long theirDelivered) {}

    public record Member(Person person, String role, Instant joinedAt) {}
    public record GroupDetail(Conversation conversation, List<Member> members, int limit) {}
    public record ReactionPeople(String emoji, List<Person> people) {}

    public record OpenRequest(Long userId) {}
    /**
     * {@code mentions}: who the writer named with "@" in a group, each with where the name stands in the body (UTF-16 offsets, the "@" included). The server
     * keeps only current members whose shown name really stands there; nothing else is trusted.
     */
    public record SendRequest(UUID ref, String body, Long replyTo, List<UUID> attachments, List<Mention> mentions) {
        public SendRequest(UUID ref, String body) { this(ref, body, null, null, null); }
        public SendRequest(UUID ref, String body, Long replyTo, List<UUID> attachments) { this(ref, body, replyTo, attachments, null); }
    }
    /** One "@Name" in a message body: the person, and the place of the name in the body (the "@" included). */
    public record Mention(long id, int at, int len) {}
    public record ShareRequest(UUID ref, String kind, Long targetId) {}
    public record ReadRequest(Long messageId) {}
    /** {@code mute}: OFF, H1, H8, D1, FOREVER. Every field is optional: only what is named changes. */
    public record SettingsRequest(Boolean muted, Boolean hidden, String mute, Boolean pinned, Boolean archived, Boolean markedUnread, String theme) {
        public SettingsRequest(Boolean muted, Boolean hidden) { this(muted, hidden, null, null, null, null, null); }
    }
    public record InviteRequest(UUID ref, String mode, UUID roomId) { public InviteRequest(UUID ref,String mode){this(ref,mode,null);} }
    public record ReactRequest(String emoji) {}
    public record GroupRequest(String title, List<Long> members) {}
    public record GroupUpdate(String title) {}
    public record MembersRequest(List<Long> members) {}
    public record RoleRequest(String role) {}
    public record Summary(int unread, int messageRequests, int friendRequests) {}

    /** One line on the private queue. Which fields are set depends on the type. */
    public record Event(String type, UUID conversationId, Message message, Long userId, Long upTo, Boolean online, Invite invite, String name, String emoji, Instant lastActiveAt, Boolean quiet) {
        /** The same message for someone who restricted its sender: it arrives, without a card, a sound or a number on the badge. */
        Event quietly() { return new Event(type, conversationId, message, userId, upTo, online, invite, name, emoji, lastActiveAt, Boolean.TRUE); }
        private static Event of(String type, UUID conversation, Message m, Long user, Long upTo, Boolean online, Invite invite, String name) { return new Event(type, conversation, m, user, upTo, online, invite, name, null, null, null); }
        static Event message(UUID conversation, Message m, String name) { return of("MESSAGE", conversation, m, m.senderId(), null, null, m.invite(), name); }
        static Event read(UUID conversation, long reader, long upTo) { return of("READ", conversation, null, reader, upTo, null, null, null); }
        static Event delivered(UUID conversation, long to, long upTo) { return of("DELIVERED", conversation, null, to, upTo, null, null, null); }
        static Event typing(UUID conversation, long user, String name) { return of("TYPING", conversation, null, user, null, null, null, name); }
        static Event presence(long user, boolean online, Instant lastActiveAt) { return new Event("PRESENCE", null, null, user, null, online, null, null, null, lastActiveAt, null); }
        static Event invite(UUID conversation, Invite invite, String name) { return of("INVITE", conversation, null, null, null, null, invite, name); }
        static Event people() { return of("PEOPLE", null, null, null, null, null, null, null); }
        /** A stranger's message waiting in Requests: the words stay there until the person looks. */
        static Event request(UUID conversation, long from, String name) { return of("MESSAGE_REQUEST", conversation, null, from, null, null, null, name); }
        static Event requestAccepted(UUID conversation, long by, String name) { return of("REQUEST_ACCEPTED", conversation, null, by, null, null, null, name); }
        static Event friendRequest(long from, String name) { return of("FRIEND_REQUEST", null, null, from, null, null, null, name); }
        static Event friendAccepted(long by, String name) { return of("FRIEND_ACCEPTED", null, null, by, null, null, null, name); }
        /** Someone's emoji on a message changed; {@code emoji} null: taken off. {@code upTo} is the message. */
        static Event reaction(UUID conversation, long message, long user, String emoji) { return new Event("REACTION", conversation, null, user, message, null, null, null, emoji, null, null); }
        /** A message was unsent: its words and files are gone for everyone. {@code upTo} is the message. */
        static Event unsent(UUID conversation, long message, long user) { return of("UNSENT", conversation, null, user, message, null, null, null); }
        /** Something about the conversation itself changed (theme, name, picture, people): read it again. */
        static Event conversation(UUID conversation) { return of("CONVERSATION", conversation, null, null, null, null, null, null); }
        /** The person is no longer in this group. */
        static Event removed(UUID conversation) { return of("REMOVED", conversation, null, null, null, null, null, null); }
    }
}
