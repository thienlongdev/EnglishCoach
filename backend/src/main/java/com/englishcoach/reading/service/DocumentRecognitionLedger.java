package com.englishcoach.reading.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * The durable daily count of documents sent to text recognition ({@code public.document_recognition_usage}, V100): the
 * {@value ReadingImportGuard#DAILY_UPLOADS} documents a day per account of {@link ReadingImportGuard}, shared by Reading
 * uploads and the Listening document extraction (one recognition host, one budget).
 *
 * <p>What counts: a document that passed the checks before sending (type, signature, size, image dimensions) and got a
 * recognition slot — whether recognition then succeeded or failed (it used the host either way). What does not count:
 * a document refused by those checks, refused for a busy slot, or that never reached the host (connection refused /
 * connect timeout ⇒ {@code NOT_SENT}). A reservation left {@code STARTED} by a crash keeps counting (never handed back).
 *
 * <p>Atomic per account across threads and processes: the count and the insert run in one transaction under
 * {@code pg_advisory_xact_lock}. The day starts at local midnight (Asia/Ho_Chi_Minh); rows are never deleted.
 */
@Slf4j
@Component
public class DocumentRecognitionLedger {

    static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final Clock clock;

    @Autowired
    public DocumentRecognitionLedger(JdbcTemplate jdbc, PlatformTransactionManager transactions) {
        this(jdbc, new TransactionTemplate(transactions), Clock.system(ZONE));
    }

    DocumentRecognitionLedger(JdbcTemplate jdbc, TransactionTemplate tx, Clock clock) {
        this.jdbc = jdbc;
        // Its own transaction, always: Reading's upload runs recognition inside the transaction that stores the
        // material, and a failed recognition rolls that back — the count and its settlement must stay.
        tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.tx = tx;
        this.clock = clock;
    }

    /** Start of the current local day (the allowance boundary). */
    Instant dayStart() {
        return LocalDate.now(clock.withZone(ZONE)).atStartOfDay(ZONE).toInstant();
    }

    /** Documents of this account counted today (STARTED, SUCCEEDED, FAILED). */
    public int usedToday(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.document_recognition_usage"
                + " WHERE user_id = ? AND created_at >= ? AND status <> 'NOT_SENT'", Integer.class, userId, Timestamp.from(dayStart()));
        return n == null ? 0 : n;
    }

    /**
     * Takes one unit of today's allowance, or refuses with 429 when {@code limit} documents were already sent today.
     * A database failure refuses with 503 (fail closed: nothing is sent uncounted).
     *
     * @return the ledger row to settle
     */
    public long reserve(long userId, int limit) {
        try {
            Long id = tx.execute(status -> {
                jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtext(?))", Object.class, "document_recognition:" + userId);
                if (usedToday(userId) >= limit) return null;
                return jdbc.queryForObject("INSERT INTO public.document_recognition_usage (user_id) VALUES (?) RETURNING id",
                        Long.class, userId);
            });
            if (id == null) {
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                        "Bạn đã tải lên " + limit + " tài liệu hôm nay. Vui lòng thử lại vào ngày mai.");
            }
            return id;
        } catch (DataAccessException | org.springframework.transaction.TransactionException e) {
            log.warn("Document recognition allowance unavailable: {}", e.getClass().getSimpleName());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Hệ thống đang bận. Vui lòng thử lại sau ít phút.");
        }
    }

    /** Settles a reservation once (SUCCEEDED / FAILED count, NOT_SENT does not); failures are only logged. */
    public void settle(long id, String status) {
        try {
            tx.executeWithoutResult(s -> jdbc.update("UPDATE public.document_recognition_usage SET status = ?, settled_at = now()"
                    + " WHERE id = ? AND status = 'STARTED'", status, id));
        } catch (DataAccessException | org.springframework.transaction.TransactionException e) {
            log.warn("Document recognition usage #{} not settled ({}): it keeps counting", id, e.getClass().getSimpleName());
        }
    }
}
