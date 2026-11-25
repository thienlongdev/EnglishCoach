package com.englishcoach.common.config;

import jakarta.persistence.EntityManagerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.orm.jpa.support.OpenEntityManagerInViewInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Open-entity-manager-in-view, as Spring Boot registered it before, except on the request paths listed in
 * {@link #CONNECTION_FREE_PATHS} (performance release 2026-11-16, PERF-01 / PERF-02).
 * <p>
 * With Hibernate's connection handling under Spring ({@code DELAYED_ACQUISITION_AND_HOLD}) a request's entity manager keeps
 * the pooled database connection from its first query until the response is written. On a path that waits for an AI
 * provider between two short transactions that would hold a connection of the 28-connection pool through the whole wait.
 * The listed paths are served without the request-wide entity manager: each of their transactions gets and returns its
 * own connection. A path may be listed only when its controller and service never touch a lazy association outside a
 * transaction (checked for each one below).
 * <p>
 * {@code spring.jpa.open-in-view=false} switches Boot's own registration off; this one is equivalent for every other path
 * and is ordered last, where Boot's auto-configured interceptor was.
 */
@Configuration
@Order(Ordered.LOWEST_PRECEDENCE)
public class OpenEntityManagerInViewConfig implements WebMvcConfigurer {

    /**
     * Requests whose AI wait must not hold a database connection:
     * - sentence-translation attempts: {@code TranslationAttemptService#submitAttempt} (entities without associations,
     *   DTO built inside the transaction, provider called between transactions).
     * - Echo chat: {@code OpenRouterChatServiceImpl} reads the learner profile, page context and every tool result inside
     *   its own short transaction ({@code EchoLearnerBrain}, {@code EchoPageContextResolver}, {@code EchoToolRegistry} /
     *   service-managed {@code @Transactional}); records and allowances are JDBC; the provider is called between them
     *   (Echo Intelligence 7.0). The streamed path runs on its own worker and never had a request entity manager.
     */
    static final String[] CONNECTION_FREE_PATHS = {
            "/api/v1/writing/translation/sessions/*/attempts",
            "/api/v1/writing/sessions/*/drafts",
            "/api/v1/writing/sessions/*/complete",
            "/api/v1/writing/sessions/*/plan/organize",
            "/api/v1/writing/sentence-checks",
            "/api/v1/writing/assessments/*/retry",
            "/api/v1/reading/materials/upload",
            "/api/v1/reading/explain-context",
            "/api/v1/reading/books/explain-selection",
            "/api/v1/reading/extract-contextual-vocabulary",
            "/api/v1/listening/import",
            "/api/v1/listening/admin/import",
            "/api/v1/listening/system/import",
            "/api/v1/listening/system/materials/*/reprocess",
            "/api/v1/speaking/shadowing/analyze",
            "/api/v1/speaking/shadowing/materials/*/units",
            "/api/v1/speaking/shadowing/units/*/ipa",
            "/api/v1/speaking/shadowing/units/*/translation",
            "/api/v1/speaking/quick-check/analyze",
            "/api/v1/speaking/quick-check/recheck",
            "/api/v1/speaking/sessions/*/turns",
            "/api/v1/speaking/sessions/*/turns/*/feedback",
            "/api/v1/speaking/scenarios/custom",
            "/api/v1/speaking/sessions/*/turns/*/audio",
            "/api/v1/speaking/sessions/*/turns/*/tts",
            "/api/v1/ai/chat",
            "/api/v1/ai/chat/stream",
    };

    /** Absent in web-layer test slices without JPA: then there is nothing to keep open. */
    private final ObjectProvider<EntityManagerFactory> entityManagerFactory;

    public OpenEntityManagerInViewConfig(ObjectProvider<EntityManagerFactory> entityManagerFactory) {
        this.entityManagerFactory = entityManagerFactory;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        EntityManagerFactory emf = this.entityManagerFactory.getIfAvailable();
        if (emf == null) return;
        OpenEntityManagerInViewInterceptor interceptor = new OpenEntityManagerInViewInterceptor();
        interceptor.setEntityManagerFactory(emf);
        registry.addWebRequestInterceptor(interceptor).excludePathPatterns(CONNECTION_FREE_PATHS);
    }
}
