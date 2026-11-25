package com.englishcoach.community.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.CommunityPostMedia;
import com.englishcoach.community.entity.PostStatus;
import com.englishcoach.community.entity.PostType;
import com.englishcoach.community.repository.CommunityPostRepository;
import org.hibernate.SessionFactory;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistry;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;
import org.junit.jupiter.api.*;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Query;
import org.testcontainers.containers.PostgreSQLContainer;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

/** Executes the actual repository JPQL on disposable PG17; no app startup or Flyway. */
class CommunityHashtagQueryTest {
    static final PostgreSQLContainer<?> db = new PostgreSQLContainer<>("postgres:17");
    static StandardServiceRegistry registry;
    static SessionFactory factory;

    @BeforeAll static void open() {
        db.start();
        registry = new StandardServiceRegistryBuilder()
                .applySetting("hibernate.connection.url", db.getJdbcUrl())
                .applySetting("hibernate.connection.username", db.getUsername())
                .applySetting("hibernate.connection.password", db.getPassword())
                .applySetting("hibernate.hbm2ddl.auto", "create-drop")
                .build();
        factory = new MetadataSources(registry).addAnnotatedClass(User.class)
                .addAnnotatedClass(CommunityPost.class).addAnnotatedClass(CommunityPostMedia.class)
                .buildMetadata().buildSessionFactory();
        try (var session = factory.openSession()) {
            var tx = session.beginTransaction();
            User author = User.builder().email("hashtag@example.test").name("Local query fixture").role(Role.ROLE_USER).build();
            session.persist(author);
            String[] contents = {"#TiengAnhMoiNgay", "Two tags #IELTS #tienganhmoingay!", "#TiengAnhMoiNgayPlus",
                    "#TiengAnhMoiNgay_Extra", "No hash TiengAnhMoiNgay", "#Other", "#TiengAnhMoiNgay", "#học_tập", "#họcXtập", "#học_tập2"};
            for (int i = 0; i < contents.length; i++) {
                session.persist(CommunityPost.builder().author(author).content(contents[i])
                        .status(i == 6 ? PostStatus.PENDING : PostStatus.PUBLISHED)
                        .postType(i == 1 ? PostType.QUESTION : PostType.GENERAL)
                        .publishedAt(Instant.parse("2026-10-11T00:00:00Z").plusSeconds(i)).build());
            }
            tx.commit();
        }
    }

    @AfterAll static void close() {
        if (factory != null) factory.close();
        if (registry != null) StandardServiceRegistryBuilder.destroy(registry);
        db.stop();
    }

    List<String> query(String tag, PostType type, int offset, int limit) throws Exception {
        var method = type == null
                ? CommunityPostRepository.class.getMethod("findPublicFeedByHashtag", String.class, Pageable.class)
                : CommunityPostRepository.class.getMethod("findPublicFeedByPostTypeAndHashtag", PostType.class, String.class, Pageable.class);
        try (var session = factory.openSession()) {
            var query = session.createQuery(method.getAnnotation(Query.class).value(), CommunityPost.class)
                    .setParameter("pattern", CommunityPostService.hashtagPattern(tag));
            if (type != null) query.setParameter("postType", type);
            return query.setFirstResult(offset).setMaxResults(limit).getResultList().stream().map(CommunityPost::getContent).toList();
        }
    }

    @Test void exactCaseInsensitiveTokensAndMultipleTags() throws Exception {
        assertThat(query(" #TiengAnhMoiNgay ", null, 0, 20))
                .containsExactly("Two tags #IELTS #tienganhmoingay!", "#TiengAnhMoiNgay");
        assertThat(query("TiengAnhMoiNgay", PostType.QUESTION, 0, 20))
                .containsExactly("Two tags #IELTS #tienganhmoingay!");
        assertThat(query("missing", null, 0, 20)).isEmpty();
    }

    @Test void paginationAppliesAfterExactMatch() throws Exception {
        assertThat(query("TiengAnhMoiNgay", null, 0, 1)).containsExactly("Two tags #IELTS #tienganhmoingay!");
        assertThat(query("TiengAnhMoiNgay", null, 1, 1)).containsExactly("#TiengAnhMoiNgay");
        assertThat(query("TiengAnhMoiNgay", null, 2, 1)).isEmpty();
    }

    @Test void vietnameseAndLiteralUnderscores() throws Exception {
        assertThat(query("HỌC_TẬP", null, 0, 20)).containsExactly("#học_tập");
    }

    @Test void clearingAndInvalidTokens() {
        assertThat(CommunityPostService.hashtagPattern(null)).isNull();
        assertThat(CommunityPostService.hashtagPattern(" ")).isNull();
        for (String invalid : List.of("#", "IELTS%", "IELTS.*", "IELTS|Reading", "two tags")) {
            assertThatIllegalArgumentException().isThrownBy(() -> CommunityPostService.hashtagPattern(invalid));
        }
    }
}
