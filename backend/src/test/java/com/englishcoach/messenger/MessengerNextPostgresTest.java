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
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * V121 on PostgreSQL 17, through the least-privilege application role: replies, reactions, unsending, attachments, a person's own choices, the shared theme,
 * restricting, activity status and groups. Every check that says "not found" is a check of isolation: a conversation, a message, a file or a group that is not
 * yours does not exist for you.
 */
class MessengerNextPostgresTest {
    private static MessengerService service;
    private static MessengerRoomService rooms;
    private static MessengerRepository repo;
    private static MessengerPresence presence;
    private static JdbcTemplate owner;
    private static Path storage;
    private record Pushed(String to, Event event) {}
    private static final List<Pushed> pushed = new CopyOnWriteArrayList<>();
    private static final Set<String> online = new HashSet<>();
    private static final List<CreateNotificationCommand> bell = new CopyOnWriteArrayList<>();

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        DriverManagerDataSource raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, account_status VARCHAR(32) DEFAULT 'ACTIVE');"
                    + "INSERT INTO public.users (id, email, name) SELECT g, 'u' || g || '@x.test', 'Learner ' || g FROM generate_series(1, 120) g;"
                    + "CREATE TABLE public.user_profiles (user_id BIGINT PRIMARY KEY, display_name VARCHAR(100), avatar_storage_key VARCHAR(255));"
                    + "CREATE TABLE public.community_follows (id BIGSERIAL PRIMARY KEY, follower_user_id BIGINT NOT NULL, following_user_id BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (follower_user_id, following_user_id));"
                    + "CREATE TABLE public.community_user_restrictions (id BIGSERIAL PRIMARY KEY, target_user_id BIGINT NOT NULL, restriction_type VARCHAR(64), expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);"
                    + "CREATE TABLE public.reading_materials (id BIGINT PRIMARY KEY, title TEXT, is_system BOOLEAN, owner_user_id BIGINT);"
                    + "CREATE TABLE public.vocab_decks (id BIGINT PRIMARY KEY, title TEXT, is_system BOOLEAN);");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V114__echo_messenger.sql", "V115__messenger_directory_and_requests.sql")) st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            // Conversations and messages from before V121 must come through it unchanged.
            st.execute("INSERT INTO public.community_follows (follower_user_id, following_user_id) VALUES (101, 102), (102, 101);"
                    + "INSERT INTO public.messenger_conversations (id, user_low, user_high, low_muted) VALUES ('00000000-0000-4000-8000-000000000001', 101, 102, TRUE);"
                    + "INSERT INTO public.messenger_messages (conversation_id, sender_id, body, client_ref) VALUES ('00000000-0000-4000-8000-000000000001', 102, 'before the upgrade', gen_random_uuid());"
                    + "UPDATE public.messenger_conversations SET last_message_id = (SELECT max(id) FROM public.messenger_messages), last_message_at = now();");
            st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V121__messenger_next_generation.sql")));
            st.execute("ALTER ROLE english_coach_app PASSWORD 'messenger-test-only'");
            st.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO english_coach_runtime; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO english_coach_runtime;");
        }
        owner = new JdbcTemplate(raw);
        DriverManagerDataSource app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "messenger-test-only");
        JdbcTemplate jdbc = new JdbcTemplate(app);
        repo = new MessengerRepository(jdbc, new ObjectMapper().findAndRegisterModules());
        MessengerPush push = new MessengerPush(null, null) {
            @Override public boolean online(String principal) { return online.contains(principal); }
            @Override public void send(String principal, Event event) { if (online.contains(principal)) pushed.add(new Pushed(principal, event)); }
        };
        NotificationService notifications = Mockito.mock(NotificationService.class);
        Mockito.when(notifications.create(Mockito.any())).thenAnswer(i -> { bell.add(i.getArgument(0)); return java.util.Optional.empty(); });
        CommunityInteractionService community = Mockito.mock(CommunityInteractionService.class);
        Mockito.when(community.followUser(Mockito.anyLong(), Mockito.anyLong(), Mockito.anyBoolean())).thenAnswer(i -> { jdbc.update("INSERT INTO public.community_follows (follower_user_id, following_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", i.<Long>getArgument(0), i.<Long>getArgument(1)); return true; });
        Mockito.when(community.unfollowUser(Mockito.anyLong(), Mockito.anyLong())).thenAnswer(i -> { jdbc.update("DELETE FROM public.community_follows WHERE follower_user_id = ? AND following_user_id = ?", i.<Long>getArgument(0), i.<Long>getArgument(1)); return true; });
        ArenaInvites arena = (mode, a, b) -> "ROOM";
        MessengerRooms roomsRepo = new MessengerRooms(jdbc, repo);
        storage = Files.createTempDirectory("messenger-next");
        MessengerFiles files = new MessengerFiles(storage.toString());
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(app));
        MessengerLoad load = new MessengerLoad(null);
        service = new MessengerService(repo, roomsRepo, files, push, arena, notifications, community, tx, load);
        rooms = new MessengerRoomService(service, repo, roomsRepo, files, push, tx, load);
        presence = new MessengerPresence(repo, push, load);
    }

    private static void friends(long a, long b) {
        owner.update("INSERT INTO public.community_follows (follower_user_id, following_user_id) VALUES (?, ?), (?, ?) ON CONFLICT DO NOTHING", a, b, b, a);
    }
    private static String mail(long id) { return "u" + id + "@x.test"; }
    private static int status(Runnable call) { try { call.run(); return 200; } catch (MessengerException e) { return e.status; } }
    private static String code(Runnable call) { try { call.run(); return "OK"; } catch (MessengerException e) { return e.code; } }
    private static Message say(long me, UUID id, String body) { return rooms.send(me, id, new SendRequest(UUID.randomUUID(), body)); }
    private static List<Message> read(long me, UUID id) { return rooms.messages(me, id, null, null, null).messages(); }
    private static Conversation listed(long me, UUID id, String scope) { return service.conversationPage(me, null, scope).items().stream().filter(c -> c.id().equals(id)).findFirst().orElse(null); }
    private static List<Event> heard(long who, String type) { return pushed.stream().filter(p -> p.to().equals(mail(who)) && p.event().type().equals(type)).map(Pushed::event).toList(); }

    private static final byte[] PNG = png(640, 480);
    private static byte[] png(int w, int h) {
        byte[] b = new byte[64];
        byte[] sig = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 'I', 'H', 'D', 'R'};
        System.arraycopy(sig, 0, b, 0, sig.length);
        b[16] = (byte) (w >>> 24); b[17] = (byte) (w >>> 16); b[18] = (byte) (w >>> 8); b[19] = (byte) w;
        b[20] = (byte) (h >>> 24); b[21] = (byte) (h >>> 16); b[22] = (byte) (h >>> 8); b[23] = (byte) h;
        return b;
    }
    private static MockMultipartFile part(String name, byte[] bytes) { return new MockMultipartFile("file", name, "application/octet-stream", bytes); }
    private static byte[] zip(String... entries) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream z = new ZipOutputStream(out)) { for (String e : entries) { z.putNextEntry(new ZipEntry(e)); z.write("x".getBytes(StandardCharsets.UTF_8)); z.closeEntry(); } }
        catch (java.io.IOException e) { throw new IllegalStateException(e); }
        return out.toByteArray();
    }

    @Test
    void whatWasThereBeforeTheUpgradeIsUnchanged() {
        UUID id = UUID.fromString("00000000-0000-4000-8000-000000000001");
        Conversation c = listed(101, id, "MAIN");
        assertThat(c).isNotNull();
        assertThat(c.kind()).isEqualTo("DIRECT");
        assertThat(c.theme()).isEqualTo("pearl");
        assertThat(c.muted()).as("the old mute switch still means muted, until turned back on").isTrue();
        assertThat(c.mutedUntil()).isEqualTo(MessengerRepository.FOREVER);
        assertThat(read(101, id)).extracting(Message::body).containsExactly("before the upgrade");
        assertThat(read(101, id).get(0).deleted()).isFalse();
        rooms.settings(101, id, new SettingsRequest(null, null, "OFF", null, null, null, null));
        assertThat(listed(101, id, "MAIN").muted()).isFalse();
    }

    @Test
    void aReplyNamesTheMessageItAnswersAndOnlyOneOfThisConversation() {
        friends(1, 2); friends(1, 3);
        UUID ab = service.open(1, 2).id(), ac = service.open(1, 3).id();
        Message first = say(1, ab, "Shall we practise tonight?"), elsewhere = say(1, ac, "Other conversation");
        Message reply = rooms.send(2, ab, new SendRequest(UUID.randomUUID(), "Yes, at eight", first.id(), null));
        assertThat(reply.replyTo()).isNotNull();
        assertThat(reply.replyTo().id()).isEqualTo(first.id());
        assertThat(reply.replyTo().text()).isEqualTo("Shall we practise tonight?");
        assertThat(reply.replyTo().senderId()).isEqualTo(1L);
        assertThat(read(1, ab)).filteredOn(m -> m.id() == reply.id()).first().satisfies(m -> assertThat(m.replyTo().id()).isEqualTo(first.id()));
        assertThat(status(() -> rooms.send(2, ab, new SendRequest(UUID.randomUUID(), "x", elsewhere.id(), null)))).as("a message of another conversation cannot be answered here").isEqualTo(404);
        assertThat(status(() -> rooms.send(2, ab, new SendRequest(UUID.randomUUID(), "x", 987654321L, null)))).isEqualTo(404);
        UUID ref = UUID.randomUUID();
        Message once = rooms.send(2, ab, new SendRequest(ref, "again", first.id(), null)), twice = rooms.send(2, ab, new SendRequest(ref, "again", first.id(), null));
        assertThat(twice.id()).as("a retried reply is one message").isEqualTo(once.id());
        // Reaching back to the message a reply answers.
        for (int i = 0; i < 30; i++) { say(1, ab, "line " + i); say(2, ab, "answer " + i); }
        MessagePage back = rooms.messages(2, ab, null, null, first.id());
        assertThat(back.messages()).extracting(Message::id).contains(first.id());
        // Removed from my list: the words of what was there are no longer shown to me, even inside a reply.
        rooms.settings(2, ab, new SettingsRequest(null, true));
        Message late = rooms.send(1, ab, new SendRequest(UUID.randomUUID(), "about that", first.id(), null));
        assertThat(read(2, ab)).filteredOn(m -> m.id() == late.id()).first().satisfies(m -> { assertThat(m.replyTo().deleted()).isTrue(); assertThat(m.replyTo().text()).isEmpty(); });
        assertThat(status(() -> rooms.send(2, ab, new SendRequest(UUID.randomUUID(), "x", first.id(), null)))).as("nor can it be answered").isEqualTo(404);
    }

    @Test
    void oneEmojiPerPersonPerMessageSeenByBothAndNobodyElse() {
        friends(4, 5);
        UUID id = service.open(4, 5).id();
        online.add(mail(4)); online.add(mail(5));
        Message m = say(4, id, "Well done!");
        rooms.react(5, m.id(), "👍");
        rooms.react(5, m.id(), "❤️");
        rooms.react(4, m.id(), "❤️");
        Message seen = read(4, id).get(0);
        assertThat(seen.reactions()).as("a second emoji from the same person replaces the first").hasSize(1);
        assertThat(seen.reactions().get(0)).satisfies(r -> { assertThat(r.emoji()).isEqualTo("❤️"); assertThat(r.count()).isEqualTo(2); assertThat(r.mine()).isTrue(); });
        assertThat(rooms.reactors(5, m.id())).first().satisfies(r -> assertThat(r.people()).extracting(Person::id).containsExactlyInAnyOrder(4L, 5L));
        assertThat(heard(4, "REACTION")).isNotEmpty();
        rooms.react(5, m.id(), null);
        assertThat(read(5, id).get(0).reactions().get(0)).satisfies(r -> { assertThat(r.count()).isEqualTo(1); assertThat(r.mine()).isFalse(); });
        assertThat(status(() -> rooms.react(6, m.id(), "👍"))).as("another learner: the message does not exist").isEqualTo(404);
        assertThat(status(() -> rooms.reactors(6, m.id()))).isEqualTo(404);
        assertThat(status(() -> rooms.react(5, m.id(), "hello"))).as("words are not a reaction").isEqualTo(400);
        assertThat(status(() -> rooms.react(5, m.id(), "<b>"))).isEqualTo(400);
        service.block(4, 5);
        assertThat(status(() -> rooms.react(5, m.id(), "👍"))).as("blocked: no reaction either").isEqualTo(403);
        service.unblock(4, 5);
    }

    @Test
    void unsendingTakesTheWordsAndTheFilesAwayForEveryoneAndOnlyTheSenderCan() throws Exception {
        friends(7, 8);
        UUID id = service.open(7, 8).id();
        Attachment file = rooms.upload(7, id, part("holiday.png", PNG), null, null);
        Message m = rooms.send(7, id, new SendRequest(UUID.randomUUID(), "Look at this", null, List.of(file.id())));
        Message answer = rooms.send(8, id, new SendRequest(UUID.randomUUID(), "Lovely", m.id(), null));
        Path stored = rooms.download(8, file.id(), false).path();
        assertThat(Files.exists(stored)).isTrue();
        assertThat(code(() -> rooms.unsend(8, m.id()))).as("not their message").isEqualTo("NOT_YOURS");
        assertThat(status(() -> rooms.unsend(9, m.id()))).isEqualTo(404);
        rooms.unsend(7, m.id());
        Message gone = read(8, id).stream().filter(x -> x.id() == m.id()).findFirst().orElseThrow();
        assertThat(gone.deleted()).isTrue();
        assertThat(gone.body()).isEmpty();
        assertThat(gone.attachments()).isEmpty();
        assertThat(Files.exists(stored)).as("the bytes are gone from the disk").isFalse();
        assertThat(status(() -> rooms.download(8, file.id(), false))).isEqualTo(404);
        assertThat(read(8, id).stream().filter(x -> x.id() == answer.id()).findFirst().orElseThrow().replyTo().deleted()).isTrue();
        assertThat(code(() -> rooms.unsend(7, m.id()))).as("once").isEqualTo("MESSAGE_GONE");
        assertThat(status(() -> rooms.react(8, m.id(), "👍"))).isEqualTo(409);
        assertThat(owner.queryForObject("SELECT count(*) FROM public.messenger_messages WHERE id = ?", Integer.class, m.id())).as("the row stays: order and replies keep their place").isEqualTo(1);
    }

    @Test
    void attachmentsAreCheckedByContentBoundedAndPrivate() throws Exception {
        friends(10, 11);
        UUID id = service.open(10, 11).id();
        Attachment picture = rooms.upload(10, id, part("../../etc/pass wd.png", PNG), new MockMultipartFile("thumb", "t.png", "image/png", png(120, 90)), null);
        assertThat(picture.kind()).isEqualTo("IMAGE");
        assertThat(picture.mime()).isEqualTo("image/png");
        assertThat(picture.width()).isEqualTo(640);
        assertThat(picture.name()).as("a label, never a path").doesNotContain("/").doesNotContain("..");
        assertThat(picture.thumb()).isTrue();
        assertThat(rooms.download(10, picture.id(), false).path().toAbsolutePath().normalize().startsWith(storage.toAbsolutePath().normalize())).isTrue();
        assertThat(status(() -> rooms.download(11, picture.id(), false))).as("waiting in a composer: its owner only").isEqualTo(404);

        assertThat(code(() -> rooms.upload(10, id, part("virus.exe", new byte[]{'M', 'Z', 1, 2, 3}), null, null))).isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("page.html", "<script>alert(1)</script>".getBytes()), null, null))).isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("drawing.svg", "<svg onload='x()'/>".getBytes()), null, null))).isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("fake.png", "not a picture at all".getBytes()), null, null))).as("the name does not make it a picture").isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("fake.pdf", "MZ this is a program".getBytes()), null, null))).as("nor a document").isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("archive.zip", zip("a.txt")), null, null))).isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("renamed.docx", zip("a.txt")), null, null))).as("a ZIP called .docx").isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("macro.docx", zip("[Content_Types].xml", "word/document.xml", "word/vbaProject.bin")), null, null))).isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("bomb.png", png(60000, 60000)), null, null))).as("a picture of absurd size").isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(code(() -> rooms.upload(10, id, part("big.pdf", new byte[MessengerFiles.FILE_MAX + 1]), null, null))).isEqualTo("ATTACHMENT_TOO_LARGE");
        byte[] bigPicture = new byte[MessengerFiles.IMAGE_MAX + 10];
        System.arraycopy(PNG, 0, bigPicture, 0, PNG.length);
        assertThat(code(() -> rooms.upload(10, id, part("huge.png", bigPicture), null, null))).isEqualTo("ATTACHMENT_TOO_LARGE");
        assertThat(code(() -> rooms.upload(10, id, part("empty.txt", new byte[0]), null, null))).isEqualTo("ATTACHMENT_EMPTY");
        assertThat(code(() -> rooms.upload(10, id, part("p.png", PNG), part("t.png", "nope".getBytes()), null))).as("a preview that is not a picture").isEqualTo("ATTACHMENT_NOT_ALLOWED");
        assertThat(storage.toFile().list() == null ? 0 : Files.walk(storage).filter(p -> p.toString().endsWith(".part")).count()).as("nothing half-written is left").isZero();

        Attachment doc = rooms.upload(10, id, part("notes.docx", zip("[Content_Types].xml", "word/document.xml")), null, null);
        Attachment pdf = rooms.upload(10, id, part("plan.pdf", "%PDF-1.7 hello".getBytes()), null, null);
        Attachment text = rooms.upload(10, id, part("list.txt", "một, hai, ba".getBytes(StandardCharsets.UTF_8)), null, null);
        assertThat(doc.kind()).isEqualTo("FILE");
        assertThat(code(() -> rooms.send(10, id, new SendRequest(UUID.randomUUID(), "", null, List.of(doc.id(), pdf.id(), text.id()))))).as("two documents a message").isEqualTo("ATTACHMENT_TOO_MANY");
        assertThat(code(() -> rooms.send(11, id, new SendRequest(UUID.randomUUID(), "", null, List.of(doc.id()))))).as("someone else's upload").isEqualTo("ATTACHMENT_GONE");
        assertThat(code(() -> rooms.send(10, id, new SendRequest(UUID.randomUUID(), "", null, List.of())))).as("no words and no files is no message").isEqualTo("MESSAGE_EMPTY");
        UUID ref = UUID.randomUUID();
        Message sent = rooms.send(10, id, new SendRequest(ref, "", null, List.of(picture.id(), doc.id(), pdf.id())));
        assertThat(sent.attachments()).extracting(Attachment::id).containsExactly(picture.id(), doc.id(), pdf.id());
        assertThat(sent.payload().path("att").path("images").asInt()).isEqualTo(1);
        assertThat(rooms.send(10, id, new SendRequest(ref, "", null, List.of(picture.id(), doc.id(), pdf.id()))).id()).as("a retry is the same message").isEqualTo(sent.id());
        assertThat(code(() -> rooms.send(10, id, new SendRequest(UUID.randomUUID(), "again", null, List.of(picture.id()))))).as("a file is sent once").isEqualTo("ATTACHMENT_GONE");
        assertThat(rooms.download(11, picture.id(), false).mime()).isEqualTo("image/png");
        assertThat(rooms.download(11, picture.id(), true).picture()).isTrue();
        assertThat(rooms.download(11, pdf.id(), false).picture()).as("a document is a download").isFalse();
        assertThat(status(() -> rooms.download(12, picture.id(), false))).as("another learner").isEqualTo(404);
        assertThat(status(() -> rooms.download(12, picture.id(), true))).isEqualTo(404);
        assertThat(status(() -> rooms.shared(12, id, "IMAGE"))).isEqualTo(404);
        assertThat(rooms.shared(11, id, "IMAGE")).extracting(Attachment::id).containsExactly(picture.id());
        assertThat(rooms.shared(11, id, "FILE")).hasSize(2);
        rooms.discard(11, text.id());
        assertThat(rooms.download(10, text.id(), false)).as("only its owner takes a waiting file back").isNotNull();
        rooms.discard(10, text.id());
        assertThat(status(() -> rooms.download(10, text.id(), false))).isEqualTo(404);

        // A stranger's first messages are words only; a blocked person uploads nothing; quotas hold.
        UUID stranger = service.open(13, 10).id();
        assertThat(code(() -> rooms.upload(13, stranger, part("p.png", PNG), null, null))).isEqualTo("NOT_CONNECTED");
        service.block(11, 10);
        assertThat(status(() -> rooms.upload(10, id, part("p.png", PNG), null, null))).isEqualTo(403);
        service.unblock(11, 10);
        owner.update("INSERT INTO public.messenger_attachments (id, owner_id, conversation_id, message_id, kind, file_name, mime, size_bytes, storage_key) SELECT gen_random_uuid(), 10, ?, ?, 'FILE', 'old', 'application/pdf', 10485760, 'a/zz/' || g FROM generate_series(1, 29) g", id, sent.id());
        assertThat(code(() -> rooms.upload(10, id, part("p.png", PNG), null, null))).as("what one person may add in a month is bounded").isEqualTo("ATTACHMENT_QUOTA");
        // Files left in a composer are removed with their bytes.
        friends(14, 15);
        UUID other = service.open(14, 15).id();
        Attachment left = rooms.upload(14, other, part("left.png", PNG), null, null);
        Path leftPath = rooms.download(14, left.id(), false).path();
        owner.update("UPDATE public.messenger_attachments SET created_at = now() - interval '2 hours' WHERE id = ?", left.id());
        new MessengerRooms(new JdbcTemplate(owner.getDataSource()), repo).abandon(10).forEach(f -> new MessengerFiles(storage.toString()).delete(f.key()));
        assertThat(Files.exists(leftPath)).isFalse();
        assertThat(status(() -> rooms.download(14, left.id(), false))).isEqualTo(404);
    }

    @Test
    void restrictingIsQuieterThanBlockingAndTheOtherPersonIsNotTold() {
        friends(20, 21);
        UUID id = service.open(20, 21).id();
        online.add(mail(20)); online.add(mail(21));
        say(21, id, "hello");
        assertThat(service.summary(20).unread()).isEqualTo(1);
        assertThat(listed(21, id, "MAIN").other().online()).isTrue();
        pushed.clear(); bell.clear();
        service.restrict(20, 21);
        assertThat(heard(21, "PEOPLE")).as("the restricted person is not told").isEmpty();
        assertThat(listed(20, id, "MAIN")).as("their conversation waits aside").isNull();
        assertThat(listed(20, id, "RESTRICTED")).isNotNull().satisfies(c -> assertThat(c.restricted()).isTrue());
        assertThat(service.summary(20).unread()).as("and is not counted on the badge").isZero();
        assertThat(service.people(20).restricted()).extracting(Person::id).containsExactly(21L);
        Message more = say(21, id, "are you there?");
        assertThat(heard(20, "MESSAGE")).as("it still arrives, quietly").hasSize(1).first().satisfies(e -> assertThat(e.quiet()).isTrue());
        online.remove(mail(20));
        say(21, id, "anyone?");
        assertThat(bell).as("no bell either").isEmpty();
        online.add(mail(20));
        pushed.clear();
        rooms.read(20, id, more.id());
        assertThat(heard(21, "READ")).as("what I have read is not told").isEmpty();
        assertThat(rooms.messages(21, id, null, null, null).theirRead()).isZero();
        assertThat(listed(21, id, "MAIN").theirRead()).isZero();
        assertThat(listed(21, id, "MAIN").other().online()).as("nor that I am here").isFalse();
        assertThat(service.profile(21, 20).person().online()).isFalse();
        assertThat(listed(21, id, "MAIN").refused()).as("they can still write").isNull();
        assertThat(say(20, id, "I can answer when I choose").id()).isPositive();
        service.unrestrict(20, 21);
        assertThat(listed(20, id, "MAIN")).isNotNull();
        assertThat(listed(21, id, "MAIN").other().online()).isTrue();
        assertThat(listed(21, id, "MAIN").theirRead()).isPositive();
    }

    @Test
    void activityIsSeenByThoseAllowedForSevenDaysAndWrittenOnceWhenThePersonLeaves() {
        friends(30, 31);
        UUID id = service.open(30, 31).id();
        say(30, id, "hi");
        online.add(mail(31));
        online.remove(mail(30));
        assertThat(listed(31, id, "MAIN").other()).satisfies(p -> { assertThat(p.online()).isFalse(); assertThat(p.lastActiveAt()).as("never seen leaving: nothing is claimed").isNull(); });
        // The last page of 30 closes: one write, and friends who may see it are told when.
        pushed.clear();
        online.add(mail(30));
        presence.settle(30, mail(30));
        assertThat(heard(31, "PRESENCE")).hasSize(1).first().satisfies(e -> assertThat(e.online()).isTrue());
        assertThat(owner.queryForObject("SELECT last_seen_at FROM public.messenger_directory WHERE user_id = 30", java.sql.Timestamp.class)).as("nothing is written while online").isNull();
        presence.settle(30, mail(30));
        assertThat(heard(31, "PRESENCE")).as("a reconnect (another page, another tab) is not news").hasSize(1);
        online.remove(mail(30));
        presence.settle(30, mail(30));
        assertThat(heard(31, "PRESENCE")).hasSize(2).last().satisfies(e -> { assertThat(e.online()).isFalse(); assertThat(e.lastActiveAt()).isNotNull(); });
        assertThat(listed(31, id, "MAIN").other().lastActiveAt()).isNotNull();
        assertThat(service.people(31).friends()).filteredOn(p -> p.id() == 30).first().satisfies(p -> assertThat(p.lastActiveAt()).isNotNull());
        owner.update("UPDATE public.messenger_directory SET last_seen_at = now() - interval '6 days 23 hours' WHERE user_id = 30");
        assertThat(listed(31, id, "MAIN").other().lastActiveAt()).isNotNull();
        owner.update("UPDATE public.messenger_directory SET last_seen_at = now() - interval '7 days 1 minute' WHERE user_id = 30");
        assertThat(listed(31, id, "MAIN").other().lastActiveAt()).as("after seven days nothing is shown").isNull();
        owner.update("UPDATE public.messenger_directory SET last_seen_at = now() - interval '2 hours' WHERE user_id = 30");
        // Hiding my own activity hides it from everyone, and hides everyone's from me.
        online.add(mail(30));
        pushed.clear();
        service.updateMe(30, new MeRequest(null, null, null, false));
        assertThat(heard(31, "PRESENCE")).as("those who were seeing me are told I am gone").hasSize(1).first().satisfies(e -> assertThat(e.online()).isFalse());
        assertThat(listed(31, id, "MAIN").other()).satisfies(p -> { assertThat(p.online()).isFalse(); assertThat(p.lastActiveAt()).isNull(); });
        assertThat(listed(30, id, "MAIN").other().online()).as("and I do not see theirs").isFalse();
        pushed.clear();
        presence.settle(30, mail(30));
        online.remove(mail(30));
        presence.settle(30, mail(30));
        assertThat(heard(31, "PRESENCE")).as("no presence news from someone who hides it").isEmpty();
        service.updateMe(30, new MeRequest(null, null, null, true));
        online.add(mail(30));
        assertThat(listed(31, id, "MAIN").other().online()).isTrue();
        // Never to a stranger, never across a block.
        UUID stranger = service.open(32, 30).id();
        say(32, stranger, "hello");
        assertThat(service.profile(32, 30).person().online()).isFalse();
        service.block(31, 30);
        assertThat(service.profile(31, 30).person().online()).isFalse();
        service.unblock(31, 30);
    }

    @Test
    void aPersonsOwnChoicesAreTheirsAndTheThemeIsShared() {
        friends(40, 41);
        UUID id = service.open(40, 41).id();
        online.add(mail(40)); online.add(mail(41));
        Message m = say(41, id, "hello");
        rooms.settings(40, id, new SettingsRequest(null, null, null, true, null, null, null));
        assertThat(listed(40, id, "MAIN").pinned()).isTrue();
        assertThat(listed(41, id, "MAIN").pinned()).as("pinning is mine alone").isFalse();
        for (long other = 42; other <= 45; other++) { friends(40, other); UUID c = service.open(40, other).id(); say(other, c, "x"); long who = other; rooms.settings(40, c, new SettingsRequest(null, null, null, true, null, null, null)); assertThat(listed(40, c, "MAIN")).isNotNull(); assertThat(who).isPositive(); }
        friends(40, 46); UUID sixth = service.open(40, 46).id(); say(46, sixth, "x");
        assertThat(code(() -> rooms.settings(40, sixth, new SettingsRequest(null, null, null, true, null, null, null)))).isEqualTo("PIN_LIMIT");
        assertThat(service.conversationPage(40, null, "MAIN").items().get(5).id()).as("pinned conversations come first").isEqualTo(sixth);
        assertThat(service.conversationPage(40, null, "MAIN").items().subList(0, 5)).allSatisfy(c -> assertThat(c.pinned()).isTrue());

        rooms.settings(40, id, new SettingsRequest(null, null, null, false, true, null, null));
        assertThat(listed(40, id, "MAIN")).as("archived: out of the main list").isNull();
        assertThat(listed(40, id, "ARCHIVED")).isNotNull().satisfies(c -> assertThat(c.archived()).isTrue());
        assertThat(service.summary(40).unread()).as("and not on the badge").isEqualTo(5);
        say(41, id, "a new message brings it back");
        assertThat(listed(40, id, "MAIN")).isNotNull().satisfies(c -> assertThat(c.archived()).isFalse());
        assertThat(listed(40, id, "ARCHIVED")).isNull();

        bell.clear();
        rooms.settings(40, id, new SettingsRequest(null, null, "H1", null, null, null, null));
        Conversation muted = listed(40, id, "MAIN");
        assertThat(muted.muted()).isTrue();
        assertThat(muted.mutedUntil()).isBetween(Instant.now().plusSeconds(3500), Instant.now().plusSeconds(3700));
        online.remove(mail(40));
        say(41, id, "while muted");
        assertThat(bell).as("a muted conversation does not ring").isEmpty();
        assertThat(read(40, id)).as("but nothing is lost").extracting(Message::body).contains("while muted");
        owner.update("UPDATE public.messenger_prefs SET muted_until = now() - interval '1 minute' WHERE conversation_id = ? AND user_id = 40", id);
        assertThat(listed(40, id, "MAIN").muted()).as("a timed mute ends by itself").isFalse();
        say(41, id, "after the mute");
        assertThat(bell).hasSize(1);
        online.add(mail(40));
        assertThat(code(() -> rooms.settings(40, id, new SettingsRequest(null, null, "TOMORROW", null, null, null, null)))).isEqualTo("INVALID_REQUEST");

        long last = read(40, id).get(read(40, id).size() - 1).id();
        rooms.read(40, id, last);
        rooms.settings(40, id, new SettingsRequest(null, null, null, null, null, true, null));
        assertThat(listed(40, id, "MAIN").markedUnread()).isTrue();
        rooms.read(40, id, last);
        assertThat(listed(40, id, "MAIN").markedUnread()).as("reading it clears the mark").isFalse();

        pushed.clear();
        rooms.settings(41, id, new SettingsRequest(null, null, null, null, null, null, "ocean"));
        assertThat(listed(40, id, "MAIN").theme()).as("the theme is the conversation's: both see it").isEqualTo("ocean");
        assertThat(listed(41, id, "MAIN").theme()).isEqualTo("ocean");
        assertThat(heard(40, "CONVERSATION")).isNotEmpty();
        Message said = read(40, id).get(read(40, id).size() - 1);
        assertThat(said.kind()).as("and the conversation says who changed it").isEqualTo("SYSTEM");
        assertThat(said.payload().path("event").asText()).isEqualTo("theme");
        assertThat(code(() -> rooms.settings(41, id, new SettingsRequest(null, null, null, null, null, null, "url(javascript:x)")))).isEqualTo("INVALID_REQUEST");
        assertThat(status(() -> rooms.settings(47, id, new SettingsRequest(null, null, null, null, null, null, "ocean")))).as("another learner").isEqualTo(404);
        assertThat(status(() -> rooms.react(40, said.id(), "👍"))).as("a line the conversation says is not reacted to").isEqualTo(409);
        assertThat(status(() -> rooms.unsend(41, said.id()))).isEqualTo(409);
        assertThat(m.id()).isPositive();
    }

    @Test
    void aGroupIsItsPeopleAndNobodyElse() {
        for (long other = 51; other <= 54; other++) friends(50, other);
        friends(51, 55);
        online.add(mail(50)); online.add(mail(51)); online.add(mail(52));
        assertThat(code(() -> rooms.createGroup(50, new GroupRequest("Study", List.of(51L, 56L))))).as("only friends are put in a group").isEqualTo("GROUP_MEMBER_NOT_ALLOWED");
        service.block(53, 50);
        assertThat(code(() -> rooms.createGroup(50, new GroupRequest("Study", List.of(51L, 53L))))).as("never across a block").isEqualTo("GROUP_MEMBER_NOT_ALLOWED");
        service.unblock(53, 50);
        assertThat(code(() -> rooms.createGroup(50, new GroupRequest("   ", List.of(51L))))).isEqualTo("GROUP_TITLE_INVALID");
        assertThat(code(() -> rooms.createGroup(50, new GroupRequest("Study", List.of(50L))))).isEqualTo("INVALID_REQUEST");
        pushed.clear();
        Conversation g = rooms.createGroup(50, new GroupRequest("  IELTS   Speaking  ", List.of(51L, 52L)));
        UUID id = g.id();
        assertThat(g.kind()).isEqualTo("GROUP");
        assertThat(g.title()).isEqualTo("IELTS Speaking");
        assertThat(g.memberCount()).isEqualTo(3);
        assertThat(g.role()).isEqualTo("OWNER");
        assertThat(g.other()).isNull();
        assertThat(heard(51, "CONVERSATION")).isNotEmpty();
        assertThat(listed(51, id, "MAIN")).isNotNull().satisfies(c -> assertThat(c.role()).isEqualTo("MEMBER"));

        Message first = say(50, id, "Welcome everyone");
        assertThat(first.senderName()).isEqualTo("Learner 50");
        assertThat(heard(51, "MESSAGE")).filteredOn(e -> e.message().id() == first.id()).hasSize(1);
        assertThat(heard(52, "MESSAGE")).filteredOn(e -> e.message().id() == first.id()).hasSize(1);
        assertThat(heard(53, "MESSAGE")).isEmpty();
        UUID ref = UUID.randomUUID();
        assertThat(rooms.send(51, id, new SendRequest(ref, "Hi")).id()).isEqualTo(rooms.send(51, id, new SendRequest(ref, "Hi")).id());
        assertThat(listed(52, id, "MAIN").unread()).isEqualTo(3);
        assertThat(service.summary(52).unread()).isEqualTo(3);
        long lastId = read(52, id).get(read(52, id).size() - 1).id();
        rooms.read(52, id, lastId);
        assertThat(listed(52, id, "MAIN").unread()).isZero();
        assertThat(service.summary(52).unread()).isZero();
        assertThat(listed(50, id, "MAIN").unread()).as("each person has their own mark").isEqualTo(1);

        // Replies, reactions and files work as in any conversation.
        Message reply = rooms.send(52, id, new SendRequest(UUID.randomUUID(), "Thank you", first.id(), null));
        assertThat(reply.replyTo().senderName()).isEqualTo("Learner 50");
        rooms.react(51, first.id(), "🎉"); rooms.react(52, first.id(), "🎉");
        assertThat(read(50, id).stream().filter(m -> m.id() == first.id()).findFirst().orElseThrow().reactions().get(0).count()).isEqualTo(2);
        Attachment picture = rooms.upload(51, id, part("board.png", PNG), null, null);
        Message withFile = rooms.send(51, id, new SendRequest(UUID.randomUUID(), "", null, List.of(picture.id())));
        assertThat(rooms.download(52, picture.id(), false).picture()).isTrue();

        // Someone who is not in it: nothing of it exists.
        assertThat(status(() -> read(53, id))).isEqualTo(404);
        assertThat(status(() -> say(53, id, "let me in"))).isEqualTo(404);
        assertThat(status(() -> rooms.group(53, id))).isEqualTo(404);
        assertThat(status(() -> rooms.download(53, picture.id(), false))).isEqualTo(404);
        assertThat(status(() -> rooms.react(53, first.id(), "👍"))).isEqualTo(404);
        assertThat(status(() -> rooms.addMembers(53, id, new MembersRequest(List.of(54L))))).isEqualTo(404);
        assertThat(status(() -> rooms.settings(53, id, new SettingsRequest(null, null, null, null, null, null, "ocean")))).isEqualTo(404);
        assertThat(status(() -> rooms.avatar(53, id))).isEqualTo(404);
        assertThat(listed(53, id, "MAIN")).isNull();

        // Ordinary members cannot add members (SOC-11); only OWNER / ADMIN may add their own friends (strangers refused).
        assertThat(code(() -> rooms.addMembers(52, id, new MembersRequest(List.of(55L))))).isEqualTo("NOT_ALLOWED");
        assertThat(code(() -> rooms.addMembers(51, id, new MembersRequest(List.of(55L))))).isEqualTo("NOT_ALLOWED");
        assertThat(code(() -> rooms.rename(51, id, new GroupUpdate("Mine now")))).isEqualTo("NOT_ALLOWED");
        assertThat(code(() -> rooms.remove(51, id, 52))).isEqualTo("NOT_ALLOWED");
        assertThat(code(() -> rooms.role(51, id, 52, new RoleRequest("ADMIN")))).isEqualTo("NOT_ALLOWED");
        rooms.role(50, id, 51, new RoleRequest("ADMIN"));
        assertThat(code(() -> rooms.addMembers(50, id, new MembersRequest(List.of(55L))))).isEqualTo("GROUP_MEMBER_NOT_ALLOWED");
        GroupDetail after = rooms.addMembers(51, id, new MembersRequest(List.of(55L)));
        assertThat(after.members()).extracting(m -> m.person().id()).containsExactlyInAnyOrder(50L, 51L, 52L, 55L);
        assertThat(read(55, id)).as("someone who joins reads from then on").extracting(Message::kind).containsExactly("SYSTEM");
        assertThat(status(() -> rooms.download(55, picture.id(), false))).as("and not the files from before").isEqualTo(404);
        assertThat(status(() -> rooms.react(55, first.id(), "👍"))).isEqualTo(404);
        assertThat(status(() -> rooms.send(55, id, new SendRequest(UUID.randomUUID(), "x", first.id(), null)))).isEqualTo(404);
        Message later = say(50, id, "For everyone now");
        assertThat(read(55, id)).extracting(Message::id).contains(later.id()).doesNotContain(first.id(), withFile.id());
        assertThat(listed(55, id, "MAIN").unread()).as("being added, and the message since").isEqualTo(2);

        // Who manages.
        assertThat(rooms.rename(51, id, new GroupUpdate("IELTS Speaking 7.0")).title()).isEqualTo("IELTS Speaking 7.0");
        assertThat(code(() -> rooms.remove(51, id, 50))).as("nobody removes the owner").isEqualTo("NOT_ALLOWED");
        pushed.clear();
        online.add(mail(55));
        rooms.remove(51, id, 55);
        assertThat(heard(55, "REMOVED")).hasSize(1);
        assertThat(status(() -> read(55, id))).as("removed: it is gone for them").isEqualTo(404);
        assertThat(listed(55, id, "MAIN")).isNull();
        Message unseen = say(50, id, "after they left");
        assertThat(heard(55, "MESSAGE")).filteredOn(e -> e.message().id() == unseen.id()).isEmpty();

        // The owner leaves: the group passes to an admin.
        rooms.leave(50, id);
        assertThat(status(() -> read(50, id))).isEqualTo(404);
        assertThat(rooms.group(51, id).conversation().role()).isEqualTo("OWNER");
        assertThat(rooms.group(51, id).members()).hasSize(2);
        // Coming back is being added again, by a friend, and reading from then on.
        rooms.addMembers(51, id, new MembersRequest(List.of(50L)));
        assertThat(read(50, id)).extracting(Message::id).doesNotContain(first.id());
        assertThat(rooms.group(50, id).conversation().role()).isEqualTo("MEMBER");

        // A person's own choices for a group, and its shared theme.
        rooms.settings(52, id, new SettingsRequest(null, null, "FOREVER", true, null, null, "aurora"));
        assertThat(listed(52, id, "MAIN")).satisfies(c -> { assertThat(c.muted()).isTrue(); assertThat(c.pinned()).isTrue(); assertThat(c.theme()).isEqualTo("aurora"); });
        assertThat(listed(51, id, "MAIN")).satisfies(c -> { assertThat(c.muted()).isFalse(); assertThat(c.theme()).isEqualTo("aurora"); });
        rooms.settings(52, id, new SettingsRequest(null, null, null, null, true, null, null));
        assertThat(listed(52, id, "MAIN")).isNull();
        assertThat(listed(52, id, "ARCHIVED")).isNotNull();
        say(51, id, "wake up");
        assertThat(listed(52, id, "MAIN")).isNotNull();

        // A message from someone a member blocked reaches that member without a card.
        service.block(52, 51);
        pushed.clear();
        Message quiet = say(51, id, "still here");
        assertThat(heard(52, "MESSAGE")).filteredOn(e -> e.message().id() == quiet.id()).first().satisfies(e -> assertThat(e.quiet()).isTrue());
        assertThat(heard(50, "MESSAGE")).filteredOn(e -> e.message().id() == quiet.id()).first().satisfies(e -> assertThat(e.quiet()).isNull());
        service.unblock(52, 51);
    }

    @Test
    void anAtMentionNamesRealMembersOnlyAndReachesThemThroughAMute() {
        for (long other = 71; other <= 74; other++) friends(70, other);
        owner.update("INSERT INTO public.user_profiles (user_id, display_name) VALUES (72, 'Minh Anh') ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name");
        online.add(mail(70)); online.add(mail(71)); online.remove(mail(72)); online.remove(mail(73));
        Conversation g = rooms.createGroup(70, new GroupRequest("Mentions", List.of(71L, 72L, 73L)));
        rooms.settings(72, g.id(), new SettingsRequest(null, null, "FOREVER", null, null, null, null));
        rooms.settings(71, g.id(), new SettingsRequest(null, null, "FOREVER", null, null, null, null));
        bell.clear(); pushed.clear();
        String body = "@Minh Anh and @Learner 71, look. @Learner 74 is not here, @Learner 73 is";
        List<Mention> asked = List.of(new Mention(72, 0, 9), new Mention(71, 14, 11), new Mention(74, 33, 11), new Mention(73, 99, 11), new Mention(72, 3, 9));
        Message m = rooms.send(70, g.id(), new SendRequest(UUID.randomUUID(), body, null, null, asked));
        List<Mention> kept = new ArrayList<>();
        m.payload().get("mentions").forEach(n -> kept.add(new Mention(n.get("id").asLong(), n.get("at").asInt(), n.get("len").asInt())));
        assertThat(kept).as("members only, each where the name really stands (a wrong offset is moved to the name), never twice the same place")
                .containsExactly(new Mention(72, 0, 9), new Mention(71, 14, 11), new Mention(73, 58, 11));
        for (Mention k : kept) assertThat(body.substring(k.at(), k.at() + k.len())).startsWith("@");
        List<CreateNotificationCommand> rung = bell.stream().filter(n -> n.actionUrl() != null && n.actionUrl().contains(g.id().toString())).toList();
        assertThat(rung).extracting(CreateNotificationCommand::userId).as("each named person once, the muted ones too; the writer and a non-member never")
                .containsExactlyInAnyOrder(72L, 71L, 73L);
        assertThat(rung).allSatisfy(n -> assertThat(n.content()).contains("nhắc đến bạn").doesNotContain("look"));
        assertThat(rung).extracting(CreateNotificationCommand::dedupeKey).doesNotHaveDuplicates().allSatisfy(k -> assertThat(k).startsWith("messenger_mention_" + m.id() + "_"));
        // A forged mention (a name that is not there, someone outside the group) changes nothing; a muted person not named hears nothing.
        bell.clear();
        Message forged = rooms.send(70, g.id(), new SendRequest(UUID.randomUUID(), "hello everyone", null, null, List.of(new Mention(72, 0, 5), new Mention(120, 0, 5))));
        assertThat(forged.payload() == null || !forged.payload().has("mentions")).isTrue();
        assertThat(bell.stream().filter(n -> n.userId() == 72L)).as("muted and not named: no bell").isEmpty();
        // Someone who blocked the writer is never called by a mention.
        rooms.settings(73, g.id(), new SettingsRequest(null, null, "OFF", null, null, null, null));
        service.block(73, 70);
        bell.clear();
        rooms.send(70, g.id(), new SendRequest(UUID.randomUUID(), "@Learner 73 please", null, null, List.of(new Mention(73, 0, 11))));
        assertThat(bell.stream().filter(n -> n.userId() == 73L)).as("blocked the writer: no mention notification").isEmpty();
    }

    @Test
    void aGroupPictureIsTheGroupsAndAwayMembersFindTheBellOnceADay() {
        for (long other = 117; other <= 119; other++) friends(116, other);
        online.add(mail(116)); online.add(mail(117));
        online.remove(mail(118)); online.remove(mail(119));
        Conversation g = rooms.createGroup(116, new GroupRequest("Bell", List.of(117L, 118L, 119L)));
        rooms.settings(119, g.id(), new SettingsRequest(null, null, "FOREVER", null, null, null, null));
        bell.clear();
        say(116, g.id(), "first");
        say(117, g.id(), "second");
        List<CreateNotificationCommand> rung = bell.stream().filter(n -> n.actionUrl() != null && n.actionUrl().contains(g.id().toString())).toList();
        assertThat(rung).as("only the member who is away and did not mute it, once a day, without the words").hasSize(1);
        assertThat(rung.get(0).userId()).isEqualTo(118L);
        assertThat(rung.get(0).content()).doesNotContain("first").doesNotContain("second");
        // The picture: set by an owner or admin, read by members only, refused when it is not a picture.
        assertThat(code(() -> rooms.setAvatar(117, g.id(), part("me.png", PNG)))).isEqualTo("NOT_ALLOWED");
        assertThat(code(() -> rooms.setAvatar(116, g.id(), part("x.png", "not a picture".getBytes())))).isEqualTo("ATTACHMENT_NOT_ALLOWED");
        Conversation withPicture = rooms.setAvatar(116, g.id(), part("group.png", PNG));
        assertThat(withPicture.avatarUrl()).startsWith("/api/v1/messenger/groups/" + g.id() + "/avatar?v=");
        assertThat(rooms.avatar(117, g.id()).picture()).isTrue();
        assertThat(rooms.avatar(117, g.id()).mime()).isEqualTo("image/png");
        assertThat(status(() -> rooms.avatar(120, g.id()))).as("not a member: not found").isEqualTo(404);
        assertThat(read(118, g.id())).extracting(Message::kind).contains("SYSTEM");
    }

    @Test
    void aGroupHasASizeAndTheMessengerStaysOneQuestionForAPageThatDoesNotShowIt() {
        for (long other = 61; other <= 115; other++) friends(60, other);
        List<Long> many = new ArrayList<>();
        for (long other = 61; other <= 61 + 48; other++) many.add(other);
        Conversation g = rooms.createGroup(60, new GroupRequest("Full house", many));
        assertThat(g.memberCount()).isEqualTo(MessengerRoomService.GROUP_SIZE);
        assertThat(code(() -> rooms.addMembers(60, g.id(), new MembersRequest(List.of(112L))))).isEqualTo("GROUP_FULL");
        assertThat(rooms.group(60, g.id()).members()).hasSize(50);
        List<Long> tooMany = new ArrayList<>(many); tooMany.add(113L); tooMany.add(114L);
        assertThat(code(() -> rooms.createGroup(60, new GroupRequest("Too many", tooMany)))).isIn("GROUP_FULL", "INVALID_REQUEST");
        assertThat(service.summary(61)).as("the badge of someone in fifty-person groups is still one statement").isNotNull();
    }
}
