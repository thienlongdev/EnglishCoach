package com.englishcoach.messenger;

import com.englishcoach.community.service.CommunityInteractionService;
import com.englishcoach.messenger.MessengerDtos.*;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.service.NotificationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The real V114 and V115 schema on PostgreSQL 17, through the least-privilege application role. Friendship is the Community follow in both directions; another person's
 * conversation does not exist for you; a retried send is one message; an invitation has one answer, and only the person invited gives it.
 */
class MessengerPostgresTest {
    private static MessengerService service;
    private static java.util.function.Supplier<MessengerService> underLoad;
    private static JdbcTemplate owner;
    private static JdbcTemplate runtime;
    private static final List<String[]> pushed = new CopyOnWriteArrayList<>();
    private static final Set<String> online = new HashSet<>();
    private static final List<CreateNotificationCommand> bell = new CopyOnWriteArrayList<>();
    private static final List<String> reservations = new ArrayList<>();
    private static final Set<String> closedRooms = new HashSet<>();

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        DriverManagerDataSource raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, account_status VARCHAR(32) DEFAULT 'ACTIVE');"
                    + "INSERT INTO public.users (id, email, name) SELECT g, 'u' || g || '@x.test', 'Learner ' || g FROM generate_series(1, 40) g;"
                    + "UPDATE public.users SET name = 'hidden@x.test' WHERE id = 9;"
                    + "CREATE TABLE public.user_profiles (user_id BIGINT PRIMARY KEY, display_name VARCHAR(100), avatar_storage_key VARCHAR(255));"
                    + "INSERT INTO public.user_profiles (user_id, display_name) VALUES (1, 'An Nguyễn'), (30, 'Đặng Thị Mỹ Linh');"
                    + "CREATE TABLE public.community_follows (id BIGSERIAL PRIMARY KEY, follower_user_id BIGINT NOT NULL, following_user_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (follower_user_id, following_user_id));"
                    + "CREATE TABLE public.community_user_restrictions (id BIGSERIAL PRIMARY KEY, target_user_id BIGINT NOT NULL, restriction_type VARCHAR(64), expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);"
                    + "CREATE TABLE public.reading_materials (id BIGINT PRIMARY KEY, title TEXT, is_system BOOLEAN, owner_user_id BIGINT);"
                    + "INSERT INTO public.reading_materials VALUES (1, 'The Sea', TRUE, NULL), (2, 'My own file', FALSE, 1);"
                    + "CREATE TABLE public.vocab_decks (id BIGINT PRIMARY KEY, title TEXT, is_system BOOLEAN);"
                    + "INSERT INTO public.vocab_decks VALUES (1, 'IELTS Words', TRUE);");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V114__echo_messenger.sql", "V115__messenger_directory_and_requests.sql", "V121__messenger_next_generation.sql","V125__bind_arena_invitations.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            st.execute("ALTER ROLE english_coach_app PASSWORD 'messenger-test-only'");
            st.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO english_coach_runtime; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO english_coach_runtime;");
        }
        owner = new JdbcTemplate(raw);
        DriverManagerDataSource app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "messenger-test-only");
        JdbcTemplate jdbc = new JdbcTemplate(app);
        runtime = jdbc;
        MessengerRepository repo = new MessengerRepository(jdbc, new ObjectMapper().findAndRegisterModules());
        MessengerPush push = new MessengerPush(null, null) {
            @Override public boolean online(String principal) { return online.contains(principal); }
            @Override public void send(String principal, Event event) { if (online.contains(principal)) pushed.add(new String[]{principal, event.type(), String.valueOf(event.conversationId())}); }
        };
        NotificationService notifications = Mockito.mock(NotificationService.class);
        Mockito.when(notifications.create(Mockito.any())).thenAnswer(i -> { bell.add(i.getArgument(0)); return java.util.Optional.empty(); });
        CommunityInteractionService community = Mockito.mock(CommunityInteractionService.class);
        Mockito.when(community.followUser(Mockito.anyLong(), Mockito.anyLong(), Mockito.anyBoolean())).thenAnswer(i -> { jdbc.update("INSERT INTO public.community_follows (follower_user_id, following_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", i.<Long>getArgument(0), i.<Long>getArgument(1)); return true; });
        Mockito.when(community.unfollowUser(Mockito.anyLong(), Mockito.anyLong())).thenAnswer(i -> { jdbc.update("DELETE FROM public.community_follows WHERE follower_user_id = ? AND following_user_id = ?", i.<Long>getArgument(0), i.<Long>getArgument(1)); return true; });
        ArenaInvites arena = new ArenaInvites() {
            @Override public String reserve(String mode, long a, long b) { String code = "ROOM" + reservations.size() + "XYZ"; reservations.add(code); return code; }
            @Override public boolean isOpen(String code) { return !closedRooms.contains(code); }
        };
        MessengerRooms rooms = new MessengerRooms(jdbc, repo);
        MessengerFiles files = new MessengerFiles(Files.createTempDirectory("messenger-test").toString());
        service = new MessengerService(repo, rooms, files, push, arena, notifications, community, new TransactionTemplate(new DataSourceTransactionManager(app)), new MessengerLoad(null));
        underLoad = () -> new MessengerService(repo, rooms, files, push, arena, notifications, community, new TransactionTemplate(new DataSourceTransactionManager(app)), new MessengerLoad(null) { @Override public boolean busy() { return true; } });
    }

    private static MessengerService serviceUnderLoad() { return underLoad.get(); }
    private static void friends(long a, long b) { service.addFriend(a, b); service.addFriend(b, a); }
    private static int status(Runnable call) {
        try { call.run(); return 200; } catch (MessengerException e) { return e.status; }
    }
    private static String code(Runnable call) {
        try { call.run(); return "OK"; } catch (MessengerException e) { return e.code; }
    }

    @Test
    void aRequestBecomesAFriendshipOnlyWhenReturned() {
        service.addFriend(2, 3);
        assertThat(service.people(2).outgoing()).extracting(Person::id).contains(3L);
        assertThat(service.people(3).incoming()).extracting(Person::id).contains(2L);
        assertThat(service.people(2).friends()).extracting(Person::id).doesNotContain(3L);
        assertThat(service.people(2).outgoing()).first().satisfies(p -> assertThat(p.relation()).isEqualTo("OUTGOING"));
        service.addFriend(3, 2);
        assertThat(service.people(2).friends()).extracting(Person::id).contains(3L);
        assertThat(service.open(2, 3).id()).isEqualTo(service.open(3, 2).id());
    }

    @Test
    void searchFindsPublicNamesAndNeverAnAddress() {
        assertThat(service.search(2, "An Ng", null).items()).extracting(Person::name).contains("An Nguyễn");
        assertThat(service.search(2, "nguyen", null).items()).as("the marks do not matter").extracting(Person::name).contains("An Nguyễn");
        assertThat(service.search(2, "NGUY", null).items()).as("the first letters of any word").extracting(Person::name).contains("An Nguyễn");
        assertThat(service.search(2, "dang linh", null).items()).as("đ is d, and words in any order").extracting(Person::name).contains("Đặng Thị Mỹ Linh");
        assertThat(service.search(2, "x.test", null).items()).as("no search by address").isEmpty();
        assertThat(service.search(2, "hidden", null).items()).as("a name that is an address is not listed").isEmpty();
        assertThat(service.search(2, "a", null).items()).as("one letter lists nobody").isEmpty();
    }

    @Test
    void aMessageIsPersistedOnceAndReadByBothOnly() {
        friends(4, 5);
        UUID id = service.open(4, 5).id();
        online.add("u5@x.test"); online.add("u4@x.test");
        UUID ref = UUID.randomUUID();
        Message first = service.send(4, id, new SendRequest(ref, "  Hello <b>there</b>\u0007  "));
        assertThat(first.body()).as("kept as text, stripped of control characters").isEqualTo("Hello <b>there</b>");
        Message retry = service.send(4, id, new SendRequest(ref, "Hello <b>there</b>"));
        assertThat(retry.id()).as("a retried send is one message").isEqualTo(first.id());
        assertThat(service.messages(5, id, null, null).messages()).extracting(Message::id).containsExactly(first.id());
        assertThat(status(() -> service.messages(6, id, null, null))).as("another learner: not found").isEqualTo(404);
        assertThat(status(() -> service.send(6, id, new SendRequest(UUID.randomUUID(), "x")))).isEqualTo(404);
        assertThat(pushed).anyMatch(p -> p[0].equals("u5@x.test") && p[1].equals("MESSAGE"));
        assertThat(service.conversations(5).get(0).unread()).isEqualTo(1);
        assertThat(service.summary(5).unread()).isEqualTo(1);
        service.read(5, id, first.id());
        assertThat(service.summary(5).unread()).isZero();
        assertThat(service.conversations(4).get(0).theirRead()).isEqualTo(first.id());
        assertThat(service.conversations(4).get(0).unread()).as("your own message is never unread").isZero();
        assertThat(code(() -> service.send(4, id, new SendRequest(UUID.randomUUID(), "   ")))).isEqualTo("MESSAGE_EMPTY");
        assertThat(code(() -> service.send(4, id, new SendRequest(UUID.randomUUID(), "x".repeat(2001))))).isEqualTo("MESSAGE_TOO_LONG");
        online.clear();
    }

    @Test
    void someoneAwayFindsItOnTheBellWithoutTheWords() {
        friends(6, 7);
        UUID id = service.open(6, 7).id();
        bell.clear();
        service.send(6, id, new SendRequest(UUID.randomUUID(), "a private sentence"));
        service.send(6, id, new SendRequest(UUID.randomUUID(), "another one"));
        assertThat(bell).as("one a day per conversation, asked of the database once").hasSize(1).allMatch(n -> !n.content().contains("private") && n.userId() == 7L);
        assertThat(service.conversations(7).get(0).unread()).isEqualTo(2);
        assertThat(service.conversations(6).get(0).theirDelivered()).as("opening the list delivered them").isEqualTo(service.conversations(6).get(0).last().id());
    }

    @Test
    void anInvitationHasOneAnswerFromTheInvitedPerson() {
        friends(2, 8);
        UUID id = service.open(2, 8).id();
        Message invite = service.invite(2, id, new InviteRequest(UUID.randomUUID(), "FREE"));
        assertThat(invite.invite().status()).isEqualTo("PENDING");
        assertThat(invite.invite().code()).as("no room exists before someone says yes").isNull();
        assertThat(code(() -> service.invite(2, id, new InviteRequest(UUID.randomUUID(), "FREE")))).isEqualTo("INVITE_PENDING");
        assertThat(code(() -> service.accept(2, invite.invite().id()))).as("the inviter cannot answer for the friend").isEqualTo("NOT_INVITED");
        assertThat(status(() -> service.accept(3, invite.invite().id()))).as("nor can a third person").isEqualTo(404);
        int before = reservations.size();
        Invite accepted = service.accept(8, invite.invite().id());
        assertThat(accepted.status()).isEqualTo("ACCEPTED");
        assertThat(accepted.code()).isNotBlank();
        assertThat(reservations).hasSize(before + 1);
        assertThat(service.accept(8, invite.invite().id()).code()).as("answering again changes nothing").isEqualTo(accepted.code());
        assertThat(reservations).hasSize(before + 1);
        assertThat(code(() -> service.decline(8, invite.invite().id()))).isEqualTo("INVITE_CLOSED");
        assertThat(service.messages(2, id, null, null).messages()).last().satisfies(m -> assertThat(m.invite().code()).isEqualTo(accepted.code()));

        Message second = service.invite(8, id, new InviteRequest(UUID.randomUUID(), "DUEL"));
        assertThat(service.decline(2, second.invite().id()).status()).isEqualTo("DECLINED");
        assertThat(service.messages(8, id, null, null).messages()).last().satisfies(m -> { assertThat(m.invite().status()).isEqualTo("DECLINED"); assertThat(m.invite().code()).isNull(); });

        Message third = service.invite(2, id, new InviteRequest(UUID.randomUUID(), "GUIDED"));
        owner.update("UPDATE public.messenger_arena_invites SET expires_at = now() - interval '1 second' WHERE id = ?", third.invite().id());
        assertThat(service.messages(8, id, null, null).messages()).last().satisfies(m -> assertThat(m.invite().status()).isEqualTo("EXPIRED"));
        assertThat(status(() -> service.accept(8, third.invite().id()))).as("an expired invitation opens nothing").isEqualTo(410);
        assertThat(code(() -> service.invite(2, id, new InviteRequest(UUID.randomUUID(), "FREE")))).as("and gives its place up").isEqualTo("OK");
        assertThat(code(() -> service.invite(2, id, new InviteRequest(UUID.randomUUID(), "WEIRD")))).isEqualTo("INVALID_REQUEST");
    }

    @Test
    void blockingStopsBothWaysAndIsNotAnnounced() {
        friends(3, 4);
        UUID id = service.open(3, 4).id();
        service.send(3, id, new SendRequest(UUID.randomUUID(), "before"));
        service.block(4, 3);
        assertThat(code(() -> service.send(3, id, new SendRequest(UUID.randomUUID(), "after")))).as("the blocked person only learns it is unavailable").isEqualTo("UNAVAILABLE");
        assertThat(code(() -> service.send(4, id, new SendRequest(UUID.randomUUID(), "after")))).isEqualTo("BLOCKED_BY_ME");
        assertThat(service.people(3).friends()).extracting(Person::id).doesNotContain(4L);
        assertThat(service.people(4).blocked()).extracting(Person::id).contains(3L);
        assertThat(service.people(3).blocked()).isEmpty();
        assertThat(service.messages(3, id, null, null).messages()).as("history stays").isNotEmpty();
        service.unblock(4, 3);
        assertThat(code(() -> service.send(3, id, new SendRequest(UUID.randomUUID(), "again")))).isEqualTo("OK");
    }

    @Test
    void aRestrictionFromCommunityAppliesHere() {
        friends(5, 7);
        UUID id = service.open(5, 7).id();
        owner.update("INSERT INTO public.community_user_restrictions (target_user_id, restriction_type) VALUES (5, 'READ_ONLY')");
        assertThat(code(() -> service.send(5, id, new SendRequest(UUID.randomUUID(), "x")))).isEqualTo("RESTRICTED");
        owner.update("UPDATE public.community_user_restrictions SET revoked_at = now() WHERE target_user_id = 5");
        assertThat(code(() -> service.send(5, id, new SendRequest(UUID.randomUUID(), "x")))).isEqualTo("OK");
    }

    @Test
    void onlyWhatTheOtherPersonCanOpenIsShared() {
        friends(6, 8);
        UUID id = service.open(6, 8).id();
        Message reading = service.share(6, id, new ShareRequest(UUID.randomUUID(), "READING", 1L));
        assertThat(reading.kind()).isEqualTo("SHARE_READING");
        assertThat(reading.payload().get("title").asText()).isEqualTo("The Sea");
        assertThat(status(() -> service.share(6, id, new ShareRequest(UUID.randomUUID(), "READING", 2L)))).as("a learner's own file is not shared").isEqualTo(404);
        assertThat(service.share(6, id, new ShareRequest(UUID.randomUUID(), "DECK", 1L)).body()).isEqualTo("IELTS Words");
    }

    @Test
    void removingAConversationIsOneSidedAndANewMessageBringsItBack() {
        friends(7, 8);
        UUID id = service.open(7, 8).id();
        Message old = service.send(7, id, new SendRequest(UUID.randomUUID(), "old"));
        service.settings(8, id, new SettingsRequest(null, true));
        assertThat(service.conversations(8)).extracting(Conversation::id).doesNotContain(id);
        assertThat(service.conversations(7)).extracting(Conversation::id).contains(id);
        service.send(7, id, new SendRequest(UUID.randomUUID(), "new"));
        assertThat(service.conversations(8)).extracting(Conversation::id).contains(id);
        assertThat(service.messages(8, id, null, null).messages()).extracting(Message::body).containsExactly("new");
        assertThat(service.messages(7, id, null, null).messages()).extracting(Message::id).contains(old.id());
        assertThatThrownBy(() -> service.settings(2, id, new SettingsRequest(true, null))).isInstanceOf(MessengerException.class);
    }

    @Test
    void everyAccountHasAUsernameFoundByAtAndNeverItsAddress() {
        String username = service.me(1).username();
        assertThat(username).as("from the public name").startsWith("annguyen_");
        assertThat(service.me(9).username()).as("a name that is an address gives nothing away").startsWith("hocvien_");
        assertThat(service.search(2, "@" + username, null).items()).extracting(Person::id).containsExactly(1L);
        assertThat(service.search(2, "@learner", null).items()).as("@ looks at usernames").isNotEmpty();
        assertThat(service.search(2, "@", null).items()).isEmpty();
        // Page by page, nobody twice.
        PersonPage first = service.search(2, "learner", null);
        assertThat(first.items()).hasSize(MessengerService.SEARCH_PAGE);
        assertThat(first.next()).isNotNull();
        PersonPage second = service.search(2, "learner", first.next());
        assertThat(second.items()).isNotEmpty().extracting(Person::id).doesNotContainAnyElementsOf(first.items().stream().map(Person::id).toList());
        // A new account is in the directory at once, under its own name; a new display name follows it. The application's own role fires these triggers.
        runtime.update("INSERT INTO public.users (id, email, name) VALUES (41, 'new@x.test', 'Quỳnh Anh')");
        assertThat(service.search(2, "quynh", null).items()).extracting(Person::id).contains(41L);
        runtime.update("INSERT INTO public.user_profiles (user_id, display_name) VALUES (41, 'Bảo Trân')");
        assertThat(service.search(2, "bao tran", null).items()).extracting(Person::id).contains(41L);
        assertThat(service.search(2, "quynh anh", null).items()).as("the old name is gone; the username stays until changed").extracting(Person::id).doesNotContain(41L);
    }

    @Test
    void aUsernameCanBeChosenButNeverTaken() {
        String taken = service.me(11).username();
        assertThat(code(() -> service.updateMe(10, new MeRequest("@" + taken, null, null)))).isEqualTo("USERNAME_TAKEN");
        assertThat(code(() -> service.updateMe(10, new MeRequest("no spaces!", null, null)))).isEqualTo("USERNAME_INVALID");
        assertThat(service.updateMe(10, new MeRequest("@Tom.Ten", null, null)).username()).isEqualTo("tom.ten");
        // Hidden: found only by the exact name.
        service.updateMe(10, new MeRequest(null, null, false));
        assertThat(service.search(2, "tom", null).items()).extracting(Person::id).doesNotContain(10L);
        assertThat(service.search(2, "Learner 10", null).items()).extracting(Person::id).doesNotContain(10L);
        assertThat(service.search(2, "@tom.ten", null).items()).extracting(Person::id).containsExactly(10L);
        service.updateMe(10, new MeRequest(null, null, true));
    }

    @Test
    void aStrangerWritesAFewMessagesThatWaitInRequests() {
        UUID id = service.open(12, 13).id();
        assertThat(service.summary(13).messageRequests()).as("nothing before the first word").isZero();
        online.add("u13@x.test");
        bell.clear(); pushed.clear();
        Message hello = service.send(12, id, new SendRequest(UUID.randomUUID(), "Hello, can we practise together?"));
        assertThat(pushed).anyMatch(p -> p[0].equals("u13@x.test") && p[1].equals("MESSAGE_REQUEST"));
        assertThat(pushed).as("no card with the words").noneMatch(p -> p[0].equals("u13@x.test") && p[1].equals("MESSAGE"));
        assertThat(bell).hasSize(1).allMatch(n -> n.userId() == 13L && !n.content().contains("practise"));
        online.clear();
        assertThat(service.summary(13).messageRequests()).isEqualTo(1);
        assertThat(service.summary(13).unread()).as("not an unread chat").isZero();
        assertThat(service.conversations(13)).as("not in Chats").extracting(Conversation::id).doesNotContain(id);
        assertThat(service.conversations(12)).as("the writer sees it, waiting").first().satisfies(c -> { assertThat(c.request()).isEqualTo("MINE"); assertThat(c.connected()).isFalse(); });
        assertThat(service.requests(13)).extracting(Conversation::id).containsExactly(id);
        assertThat(service.requests(13).get(0).last().body()).contains("practise");
        // A request is a few messages, not a conversation, and nothing but words.
        service.send(12, id, new SendRequest(UUID.randomUUID(), "two"));
        service.send(12, id, new SendRequest(UUID.randomUUID(), "three"));
        assertThat(code(() -> service.send(12, id, new SendRequest(UUID.randomUUID(), "four")))).isEqualTo("REQUEST_LIMIT");
        assertThat(code(() -> service.invite(12, id, new InviteRequest(UUID.randomUUID(), "FREE")))).isEqualTo("NOT_CONNECTED");
        assertThat(code(() -> service.share(12, id, new ShareRequest(UUID.randomUUID(), "READING", 1L)))).isEqualTo("NOT_CONNECTED");
        // The person it waits for answers before writing; nobody else can answer.
        assertThat(code(() -> service.send(13, id, new SendRequest(UUID.randomUUID(), "x")))).isEqualTo("REQUEST_TO_ANSWER");
        assertThat(code(() -> service.acceptRequest(12, id))).as("the writer cannot accept their own").isEqualTo("REQUEST_CLOSED");
        assertThat(status(() -> service.acceptRequest(14, id))).as("a third person: not found").isEqualTo(404);
        service.acceptRequest(13, id);
        assertThat(code(() -> service.acceptRequest(13, id))).as("once").isEqualTo("REQUEST_CLOSED");
        assertThat(service.conversations(13)).extracting(Conversation::id).contains(id);
        assertThat(service.summary(13).unread()).as("now they count").isEqualTo(3);
        assertThat(code(() -> service.send(13, id, new SendRequest(UUID.randomUUID(), "Sure!")))).isEqualTo("OK");
        assertThat(code(() -> service.send(12, id, new SendRequest(UUID.randomUUID(), "great")))).isEqualTo("OK");
        assertThat(code(() -> service.invite(12, id, new InviteRequest(UUID.randomUUID(), "FREE")))).as("then the Arena").isEqualTo("OK");
    }

    @Test
    void aDeclinedRequestIsSilentAndABlockEndsIt() {
        UUID id = service.open(15, 16).id();
        service.send(15, id, new SendRequest(UUID.randomUUID(), "hi"));
        service.declineRequest(16, id);
        assertThat(service.requests(16)).isEmpty();
        assertThat(service.conversations(16)).extracting(Conversation::id).doesNotContain(id);
        assertThat(code(() -> service.send(15, id, new SendRequest(UUID.randomUUID(), "hello?")))).as("they only learn it is unavailable").isEqualTo("UNAVAILABLE");
        // The person who said no can still start one of their own.
        assertThat(code(() -> service.send(16, id, new SendRequest(UUID.randomUUID(), "changed my mind")))).isEqualTo("OK");
        assertThat(service.requests(15)).extracting(Conversation::id).containsExactly(id);

        UUID other = service.open(17, 18).id();
        service.send(17, other, new SendRequest(UUID.randomUUID(), "spam"));
        service.block(18, 17);
        assertThat(service.requests(18)).isEmpty();
        assertThat(code(() -> service.send(17, other, new SendRequest(UUID.randomUUID(), "again")))).isEqualTo("UNAVAILABLE");
        assertThat(code(() -> service.open(17, 18))).as("nor a new conversation").isEqualTo("UNAVAILABLE");
        assertThat(code(() -> service.addFriend(17, 18))).as("nor a friend request").isEqualTo("UNAVAILABLE");
        assertThat(service.search(17, "Learner 18", null).items()).as("nor finding them").extracting(Person::id).doesNotContain(18L);
        assertThat(status(() -> service.profile(17, 18))).as("nor their card").isEqualTo(404);
    }

    @Test
    void someoneCanAcceptMessagesFromFriendsOnly() {
        service.updateMe(19, new MeRequest(null, "FRIENDS", null));
        assertThat(code(() -> service.open(20, 19))).isEqualTo("FRIENDS_ONLY");
        friends(20, 19);
        assertThat(code(() -> service.open(20, 19))).isEqualTo("OK");
        service.updateMe(19, new MeRequest(null, "EVERYONE", null));
    }

    @Test
    void friendRequestsAreAskedAnsweredAndNeverAskedTwice() {
        bell.clear();
        service.addFriend(21, 22);
        service.addFriend(21, 22);
        assertThat(bell).as("asking twice is one request").hasSize(1);
        assertThat(service.summary(22).friendRequests()).isEqualTo(1);
        assertThat(service.search(21, "Learner 22", null).items()).first().satisfies(p -> assertThat(p.relation()).isEqualTo("OUTGOING"));
        assertThat(service.search(22, "Learner 21", null).items()).first().satisfies(p -> assertThat(p.relation()).isEqualTo("INCOMING"));
        // Taken back.
        service.removeFriend(21, 22);
        assertThat(service.summary(22).friendRequests()).isZero();
        // Declined: gone, and not asked again today.
        service.addFriend(21, 22);
        service.declineFriend(22, 21);
        assertThat(service.people(21).outgoing()).isEmpty();
        assertThat(code(() -> service.addFriend(21, 22))).isEqualTo("REQUEST_DECLINED");
        // The other person can still ask; the first answer makes them friends and tells them.
        service.addFriend(22, 21);
        bell.clear();
        service.addFriend(21, 22);
        assertThat(bell).hasSize(1).allMatch(n -> n.userId() == 22L);
        assertThat(service.people(21).friends()).extracting(Person::id).contains(22L);
        assertThat(service.profile(21, 22).connected()).isTrue();
        // Removing a friend ends it on both sides; history stays and anything new starts from the beginning.
        UUID id = service.open(21, 22).id();
        service.send(21, id, new SendRequest(UUID.randomUUID(), "hello friend"));
        service.removeFriend(21, 22);
        assertThat(service.people(21).friends()).isEmpty();
        assertThat(service.people(22).friends()).isEmpty();
        assertThat(service.messages(22, id, null, null).messages()).isNotEmpty();
        assertThat(service.conversations(22).stream().filter(c -> c.id().equals(id)).findFirst().orElseThrow().connected()).isFalse();
    }

    @Test
    void aFollowInCommunityIsTheSameRelationAndSettlesAWaitingRequest() {
        UUID id = service.open(23, 24).id();
        service.send(23, id, new SendRequest(UUID.randomUUID(), "hi"));
        owner.update("INSERT INTO public.community_follows (follower_user_id, following_user_id) VALUES (23, 24), (24, 23)");
        service.followChanged(24, 23);
        assertThat(service.people(24).friends()).extracting(Person::id).contains(23L);
        assertThat(service.requests(24)).isEmpty();
        assertThat(service.conversations(24)).extracting(Conversation::id).contains(id);
    }

    @Test
    void anAcceptedInvitationStopsOfferingARoomThatHasClosed() {
        friends(25, 26);
        UUID id = service.open(25, 26).id();
        Message invite = service.invite(25, id, new InviteRequest(UUID.randomUUID(), "FREE"));
        String code = service.accept(26, invite.invite().id()).code();
        assertThat(service.messages(25, id, null, null).messages()).last().satisfies(m -> { assertThat(m.invite().status()).isEqualTo("ACCEPTED"); assertThat(m.invite().code()).isEqualTo(code); });
        closedRooms.add(code);
        assertThat(service.messages(25, id, null, null).messages()).last().satisfies(m -> { assertThat(m.invite().status()).isEqualTo("CLOSED"); assertThat(m.invite().code()).isNull(); });
        assertThat(service.conversations(26).stream().filter(c -> c.id().equals(id)).findFirst().orElseThrow().last().invite().status()).isEqualTo("CLOSED");
        assertThat(service.accept(26, invite.invite().id()).code()).as("answering again opens nothing").isNull();
        closedRooms.clear();
    }

    @Test
    void aBusyServerDropsTheCourtesiesFirst() {
        MessengerService pressed = serviceUnderLoad();
        friends(27, 28);
        UUID id = service.open(27, 28).id();
        online.add("u28@x.test");
        pushed.clear();
        pressed.typing(27, id);
        assertThat(pushed).as("typing costs a query the first time: not now").isEmpty();
        assertThat(code(() -> pressed.send(27, id, new SendRequest(UUID.randomUUID(), "still arrives")))).isEqualTo("OK");
        online.clear();
    }
}
