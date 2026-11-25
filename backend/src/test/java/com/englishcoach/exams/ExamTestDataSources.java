package com.englishcoach.exams;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.testcontainers.containers.JdbcDatabaseContainer;

/**
 * Exams Phase 9H (test infrastructure only) — a small pooled data source for the Testcontainers classes. An unpooled
 * {@code DriverManagerDataSource} opens one TCP connection per statement, which exhausted Windows ephemeral ports
 * ({@code BindException}) when many DB-heavy classes ran in one Maven JVM. Production data-source configuration is not
 * involved. Callers close the pool before stopping the container.
 */
public final class ExamTestDataSources {

    private ExamTestDataSources() {}

    public static HikariDataSource pooled(JdbcDatabaseContainer<?> container) {
        HikariConfig hc = new HikariConfig();
        hc.setJdbcUrl(container.getJdbcUrl());
        hc.setUsername(container.getUsername());
        hc.setPassword(container.getPassword());
        hc.setMaximumPoolSize(4);
        hc.setPoolName("exams-test-" + container.getContainerId().substring(0, 8));
        return new HikariDataSource(hc);
    }
}
