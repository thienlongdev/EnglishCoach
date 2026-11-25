package com.englishcoach.garden.infra;

import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.PreparedStatementSetter;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import javax.sql.DataSource;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.LongAdder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Garden's {@link JdbcTemplate} (Phase 5). The production database is a network round trip of about 91 ms away from
 * the backend, so the cost of a garden request is the NUMBER of exchanges, not the work of any statement. Inside a
 * {@link GardenScope} — one garden transaction, or the read-only collection that precedes it — this template:
 * <ul>
 *   <li><b>remembers a read</b>: the result set of a plain {@code SELECT} stays open (it is fully in client memory) and
 *   is replayed to every later caller that asks the same SQL with the same parameters. Each caller runs its own row
 *   mapper over the real driver result set, so nothing is converted, copied or shared between callers;</li>
 *   <li><b>sends many reads at once</b>: {@link GardenScope#prefetch} runs "probes" — ordinary repository or view calls
 *   — in a recording mode in which the first read a probe has no result for is noted and the probe stops; all noted
 *   reads then travel as ONE multi-statement exchange and their result sets are remembered. A later real call finds its
 *   result waiting. A probe never executes anything: a write or a lock inside a probe only ends that probe;</li>
 *   <li><b>forgets on write</b>: every statement that is not a plain read drops the remembered results whose SQL names a
 *   table it writes; a lock, or a statement this class cannot read, drops them all. A read after a write therefore
 *   always goes to the database.</li>
 * </ul>
 *
 * <p>Correctness never depends on a prefetch: a result is used only for exactly the same SQL text and parameters, in the
 * same transaction, with no write to any table it names in between. A probe that guesses wrong costs a statement, never
 * a wrong answer. Only tables the Garden alone writes ({@code garden_*}, written only through this class) and the
 * learning tables it reads but neither it nor anything it calls writes inside a garden transaction are remembered; a
 * read of any other table always executes.</p>
 *
 * <p>Outside a scope, and when switched off ({@code app.garden.batch-reads=false}), this is a plain JdbcTemplate.</p>
 */
public final class GardenJdbc extends JdbcTemplate {

    /** Tables of other modules the Garden reads; neither it nor a service it calls writes them in a garden transaction. */
    private static final Set<String> FOREIGN_READ_ONLY = Set.of("flashcards", "dictionary_entries", "vocab_decks",
            "learning_activity_events", "listening_sessions", "exercise_attempts", "card_blast_runs", "users",
            "user_profiles", "speaking_shadowing_attempts", "word_chain_results", "writing_assessments",
            "writing_submissions");

    /** At most this many statements, and about this many characters of SQL, travel in one exchange. */
    private static final int MAX_STATEMENTS = 64;
    private static final int MAX_CHARS = 24_000;
    /** A transaction that remembers more result sets than this starts again from nothing (bounds client memory). */
    private static final int MAX_OPEN = 400;

    private static final Pattern WRITE_WORD = Pattern.compile("(?<![a-z0-9_])(insert|update|delete|merge|truncate)(?![a-z0-9_])");
    private static final Pattern WRITTEN = Pattern.compile(
            "(?<![a-z0-9_])(?:insert\\s+into|update|delete\\s+from|merge\\s+into|truncate(?:\\s+table)?)\\s+(?:only\\s+)?(?:public\\.)?\"?([a-z_][a-z0-9_]*)");
    private static final Pattern ROW_LOCK = Pattern.compile("(?<![a-z0-9_])for\\s+(update|share|no\\s+key|key\\s+share)(?![a-z0-9_])");
    private static final Pattern NOT_REPEATABLE = Pattern.compile(
            "nextval|setval|currval|random\\s*\\(|clock_timestamp|statement_timestamp|timeofday|txid_|pg_sleep|set_config|pg_notify|lo_");
    private static final Pattern QUALIFIED = Pattern.compile("(?<![a-z0-9_])([a-z_][a-z0-9_]*)\\.([a-z_][a-z0-9_]*)\\s*(\\()?");
    private static final Pattern SOURCE = Pattern.compile("(?<![a-z0-9_])(?:from|join)\\s+(?:lateral\\s+)?([a-z_][a-z0-9_]*)(\\s*[.(])?");
    private static final Pattern CTE = Pattern.compile("(?<![a-z0-9_])([a-z_][a-z0-9_]*)\\s+as\\s+(?:not\\s+materialized\\s+|materialized\\s+)?\\(");
    private static final Pattern WORD = Pattern.compile("[a-z_][a-z0-9_]*");

    private static volatile boolean enabled = true;
    /** Diagnostics (tests): told every exchange this class sends or passes on, as one line. Null in production. */
    private static volatile java.util.function.Consumer<String> observer;
    private static final LongAdder EXCHANGES = new LongAdder();
    private static final Map<String, Shape> SHAPES = new ConcurrentHashMap<>();
    /**
     * SQL that failed inside a speculative exchange outside a transaction (a learning module's table that is missing or
     * drifted): it is never sent together with others again, so one broken source cannot keep the healthy ones from
     * travelling together. It still runs — and fails, and is skipped by its caller — exactly where it always did.
     */
    private static final Map<String, Long> ALONE = new ConcurrentHashMap<>();
    /** How long such a statement stays out of shared exchanges before it is given another chance. */
    private static final long ALONE_MILLIS = 10 * 60_000L;

    private static boolean keptApart(String sql) {
        Long until = ALONE.get(sql);
        if (until == null) return false;
        if (until > System.currentTimeMillis()) return true;
        ALONE.remove(sql, until);
        return false;
    }

    /** Tests: forget which statements failed in a shared exchange. */
    public static void forgetFailures() {
        ALONE.clear();
    }

    private static final Class<?> PG_STATEMENT = pgStatement();
    private static final Method PREPARE_THRESHOLD = prepareThreshold();

    /** Thrown inside a probe when it reaches a statement that has no remembered result; an Error so no fault isolation swallows it. */
    static final class Deferred extends Error {
        static final Deferred INSTANCE = new Deferred();

        private Deferred() {
            super("garden probe deferred", null, false, false);
        }
    }

    private enum Kind { READ, PLAIN_READ, WRITE, OPAQUE }

    /** What one SQL text is: a read that may be remembered (with every word it contains), a write (with its tables), or unknown. */
    private record Shape(Kind kind, Set<String> words, Set<String> written) {}

    private record Bind(Method method, Object[] args) {}

    private record Key(String sql, List<Object> binds) {}

    private record Pending(GardenJdbc jdbc, Key key, String sql, List<Bind> binds, int parameters, Set<String> words, boolean keep) {}

    private record Kept(ResultSet rows, Set<String> words) {}

    public static GardenJdbc of(JdbcTemplate jdbc) {
        return jdbc instanceof GardenJdbc g ? g : new GardenJdbc(jdbc);
    }

    private GardenJdbc(JdbcTemplate source) {
        super(java.util.Objects.requireNonNull(source.getDataSource(), "garden JDBC needs a data source"));
        setFetchSize(source.getFetchSize());
        setMaxRows(source.getMaxRows());
        setQueryTimeout(source.getQueryTimeout());
    }

    /** {@code app.garden.batch-reads}: false makes every instance a plain JdbcTemplate again (an operational switch). */
    public static void setEnabled(boolean on) {
        enabled = on;
    }

    public static boolean enabled() {
        return enabled;
    }

    public static void observe(java.util.function.Consumer<String> to) {
        observer = to;
    }

    private static void tell(String what, String sql) {
        var to = observer;
        if (to == null) return;
        String line = String.join(" ", sql.strip().split("[ \\t\\r\\n]+"));
        to.accept(what + " " + (line.length() > 130 ? line.substring(0, 130) : line));
    }

    /** Statements-carrying exchanges this class has sent since start (diagnostics and tests; a prefetch counts once). */
    public static long exchanges() {
        return EXCHANGES.sum();
    }

    // ------------------------------------------------------------------------------------------------ reads

    @Override
    public <T> T query(String sql, PreparedStatementSetter pss, ResultSetExtractor<T> rse) throws DataAccessException {
        Session s = GardenScope.session();
        if (s == null) return super.query(sql, pss, rse);
        Shape shape = shape(sql);
        if (shape.kind() != Kind.READ) {
            // a write that returns rows (INSERT … RETURNING): the held-back writes travel in the same exchange, before it
            if (shape.kind() == Kind.WRITE && s.carries()) {
                List<Bind> own = record(pss);
                if (own != null) return s.write(this, sql, own, shape.written(), rse);
            }
            s.before(shape);
            tell(shape.kind().name(), sql);
            return counted(() -> super.query(sql, pss, rse));
        }
        List<Bind> binds = record(pss);
        if (binds == null) {
            if (s.recording != null) throw Deferred.INSTANCE;
            tell("UNRECORDED", sql);
            return counted(() -> super.query(sql, pss, rse));
        }
        return s.read(this, sql, binds, shape.words(), rse);
    }

    @Override
    public <T> T query(String sql, ResultSetExtractor<T> rse) throws DataAccessException {
        Session s = GardenScope.session();
        if (s == null) return super.query(sql, rse);
        Shape shape = shape(sql);
        if (shape.kind() != Kind.READ) {
            s.before(shape);
            tell(shape.kind().name(), sql);
            return counted(() -> super.query(sql, rse));
        }
        return s.read(this, sql, List.of(), shape.words(), rse);
    }

    // ------------------------------------------------------------------------------------------------ writes

    @Override
    public int update(String sql, PreparedStatementSetter pss) throws DataAccessException {
        Session s = GardenScope.session();
        if (s != null && s.carries()) {
            Shape shape = shape(sql);
            List<Bind> own = shape.kind() == Kind.WRITE ? record(pss) : null;
            // the held-back writes travel in the same exchange, before this one; its row count is the answer
            if (own != null) return s.write(this, sql, own, shape.written(), (ResultSetExtractor<Integer>) null);
        }
        written(sql);
        return super.update(sql, pss);
    }

    @Override
    public int update(String sql) throws DataAccessException {
        written(sql);
        return super.update(sql);
    }

    @Override
    public void execute(String sql) throws DataAccessException {
        written(sql);
        super.execute(sql);
    }

    @Override
    public int[] batchUpdate(String... sql) throws DataAccessException {
        for (String one : sql) written(one);
        return super.batchUpdate(sql);
    }

    @Override
    public int[] batchUpdate(String sql, org.springframework.jdbc.core.BatchPreparedStatementSetter pss) throws DataAccessException {
        written(sql);
        return super.batchUpdate(sql, pss);
    }

    @Override
    public <T> T execute(String sql, org.springframework.jdbc.core.PreparedStatementCallback<T> action) throws DataAccessException {
        written(sql);
        return super.execute(sql, action);
    }

    @Override
    public <T> T execute(org.springframework.jdbc.core.ConnectionCallback<T> action) throws DataAccessException {
        unknown();
        return super.execute(action);
    }

    @Override
    public <T> T execute(org.springframework.jdbc.core.StatementCallback<T> action) throws DataAccessException {
        unknown();
        return super.execute(action);
    }

    @Override
    public <T> T execute(org.springframework.jdbc.core.PreparedStatementCreator psc,
                         org.springframework.jdbc.core.PreparedStatementCallback<T> action) throws DataAccessException {
        unknown();
        return super.execute(psc, action);
    }

    @Override
    public int update(org.springframework.jdbc.core.PreparedStatementCreator psc) throws DataAccessException {
        unknown();
        return super.update(psc);
    }

    @Override
    public int update(org.springframework.jdbc.core.PreparedStatementCreator psc, org.springframework.jdbc.support.KeyHolder keys)
            throws DataAccessException {
        unknown();
        return super.update(psc, keys);
    }

    @Override
    public <T> T query(org.springframework.jdbc.core.PreparedStatementCreator psc, ResultSetExtractor<T> rse) throws DataAccessException {
        unknown();
        return super.query(psc, rse);
    }

    /** A statement that is not a plain read: inside a probe it ends the probe; otherwise it drops what it may change. */
    private void written(String sql) {
        Session s = GardenScope.session();
        if (s == null) return;
        s.before(shape(sql));
        tell("WRITE", sql);
        EXCHANGES.increment();
    }

    private void unknown() {
        Session s = GardenScope.session();
        if (s == null) return;
        s.before(new Shape(Kind.OPAQUE, Set.of(), Set.of()));
        EXCHANGES.increment();
    }

    private static <T> T counted(java.util.function.Supplier<T> call) {
        EXCHANGES.increment();
        return call.get();
    }

    // ------------------------------------------------------------------------------------------------ late writes

    /**
     * A write whose result nobody reads (an activity time, a log line, a ledger line, the stored response of a
     * command). Inside a garden transaction it is held back and sent together with the writes of its kind that follow
     * it, in order, in ONE exchange — before any later write, lock or statement this class cannot read, before any
     * read that names a table it writes, and at the latest when the transaction's work is done
     * ({@link GardenScope#flush}). No statement can therefore observe that it was late; only a failure of the write
     * itself surfaces at that later point, in the same transaction. Elsewhere it is an ordinary update.
     */
    public void updateLater(String sql, Object... args) {
        Session s = GardenScope.session();
        if (s == null) {
            update(sql, args);
            return;
        }
        if (s.recording != null) throw Deferred.INSTANCE;
        s.sync(this);
        Shape shape = shape(sql);
        List<Bind> binds = s.holder == null || shape.kind() != Kind.WRITE ? null : record(newArgPreparedStatementSetter(args));
        if (binds == null) {
            update(sql, args);
            return;
        }
        s.late.add(new Pending(this, null, sql, binds, binds.size(), shape.written(), false));
    }

    // ------------------------------------------------------------------------------------------------ lock + prefetch

    /**
     * One exchange: {@code lockSql} (executed first, its rows discarded), then the first unread statement of every
     * probe. The server takes the lock before it runs the reads, exactly as two separate statements would. Outside a
     * scope, or switched off, only the lock is executed.
     */
    public void lockThen(String lockSql, Object lockArgument, Runnable... probes) {
        Session s = GardenScope.session();
        if (s == null) {
            super.query(lockSql, ps -> ps.setObject(1, lockArgument), (ResultSetExtractor<Void>) rs -> null);
            return;
        }
        if (s.recording != null) throw Deferred.INSTANCE;
        List<Bind> binds = record(ps -> ps.setObject(1, lockArgument));
        s.sync(this);
        s.flush();
        s.forgetAll();
        s.recording = new ArrayList<>();
        s.recording.add(new Pending(this, null, lockSql, binds, 1, Set.of(), false));
        List<Pending> pending;
        try {
            for (Runnable probe : probes) s.probe(probe);
        } finally {
            pending = s.recording;
            s.recording = null;
        }
        s.send(pending, true);
    }

    // ------------------------------------------------------------------------------------------------ the session

    /** What one {@link GardenScope} remembers; never shared between threads, closed with the scope. */
    static final class Session implements AutoCloseable {
        private Object holder;
        private boolean bound;
        private Connection owned;
        private DataSource ownedFrom;
        private final Map<Key, Kept> kept = new LinkedHashMap<>();
        private final List<Statement> open = new ArrayList<>();
        private List<Pending> recording;
        private boolean prefetchOff;
        /** Writes held back by {@link GardenJdbc#updateLater}, in order. */
        private final List<Pending> late = new ArrayList<>();

        /** A remembered result belongs to one connection: a different transaction (or none) starts from nothing. */
        private void sync(GardenJdbc jdbc) {
            Object now = TransactionSynchronizationManager.getResource(jdbc.obtainDataSource());
            if (bound && now == holder) return;
            if (!late.isEmpty()) throw new IllegalStateException("garden writes pending across transactions");
            reset();
            holder = now;
            bound = true;
        }

        /** Sends the held-back writes, in order, in one exchange; what they write is forgotten like after any write. */
        void flush() {
            if (late.isEmpty()) return;
            List<Pending> writes = new ArrayList<>(late);
            late.clear();
            exchangeWrites(writes.getFirst().jdbc(), writes, false, null);
        }

        /** A write may carry the held-back ones only inside a transaction and outside a probe. */
        private boolean carries() {
            return recording == null && holder != null && !late.isEmpty();
        }

        /**
         * One exchange: the held-back writes in order, then this write. Returns what the write alone would have
         * returned: its row count, or (a RETURNING statement) what {@code rows} makes of its rows.
         */
        @SuppressWarnings("unchecked")
        private <T> T write(GardenJdbc jdbc, String sql, List<Bind> binds, Set<String> written, ResultSetExtractor<?> rows) {
            sync(jdbc);
            List<Pending> writes = new ArrayList<>(late);
            late.clear();
            writes.add(new Pending(jdbc, null, sql, binds, binds.size(), written, false));
            return (T) exchangeWrites(jdbc, writes, true, rows);
        }

        private Object exchangeWrites(GardenJdbc jdbc, List<Pending> writes, boolean answerLast, ResultSetExtractor<?> rows) {
            for (Pending w : writes) kept.values().removeIf(k -> w.words().stream().anyMatch(k.words()::contains));
            Pending current = writes.getFirst();
            try {
                Connection con = connection(jdbc);
                StringBuilder sql = new StringBuilder();
                for (Pending w : writes) {
                    if (!sql.isEmpty()) sql.append("\n;\n");
                    sql.append(strip(w.sql()));
                }
                try (PreparedStatement ps = con.prepareStatement(sql.toString())) {
                    oneShot(ps);
                    int offset = 0;
                    for (Pending w : writes) {
                        for (Bind b : w.binds()) replay(ps, con, b, offset);
                        offset += w.parameters();
                    }
                    EXCHANGES.increment();
                    if (observer != null) {
                        tell("WRITES", writes.size() + " statements");
                        for (Pending w : writes) tell("   ", w.sql());
                    }
                    boolean hasRows = ps.execute();
                    Object answer = null;
                    // every statement is walked through, so a failure of any of them surfaces here, in order
                    for (int i = 0; i < writes.size(); i++) {
                        current = writes.get(i);
                        if (i > 0) hasRows = ps.getMoreResults();
                        if (answerLast && i == writes.size() - 1) {
                            if (rows == null) {
                                answer = ps.getUpdateCount();
                            } else {
                                if (!hasRows) throw new SQLException("garden write returned no rows object");
                                try (ResultSet rs = ps.getResultSet()) {
                                    answer = rows.extractData(rs);
                                }
                            }
                        }
                    }
                    return answer;
                }
            } catch (SQLException e) {
                throw jdbc.translateException("garden write", current.sql(), e);
            }
        }

        private boolean lateTouches(Set<String> words) {
            for (Pending w : late) {
                for (String table : w.words()) if (words.contains(table)) return true;
            }
            return false;
        }

        private Connection connection(GardenJdbc jdbc) throws SQLException {
            DataSource ds = jdbc.obtainDataSource();
            if (holder != null) return DataSourceUtils.getConnection(ds);
            if (owned == null) {
                owned = DataSourceUtils.getConnection(ds);
                ownedFrom = ds;
            }
            return owned;
        }

        private void before(Shape shape) {
            if (recording != null) throw Deferred.INSTANCE;
            flush();
            switch (shape.kind()) {
                case WRITE -> kept.values().removeIf(k -> shape.written().stream().anyMatch(k.words()::contains));
                case OPAQUE -> forgetAll();
                default -> { }
            }
        }

        private void forgetAll() {
            kept.clear();
        }

        private <T> T read(GardenJdbc jdbc, String sql, List<Bind> binds, Set<String> words, ResultSetExtractor<T> rse) {
            sync(jdbc);
            if (!late.isEmpty() && lateTouches(words)) {
                if (recording != null) throw Deferred.INSTANCE;
                flush();
            }
            Key key = new Key(sql, keyOf(binds));
            Kept hit = kept.get(key);
            if (hit == null) {
                Pending one = new Pending(jdbc, key, sql, binds, parameters(binds), words, true);
                if (recording != null) {
                    if (!keptApart(sql) && recording.stream().noneMatch(p -> key.equals(p.key()))) recording.add(one);
                    throw Deferred.INSTANCE;
                }
                send(List.of(one), true);
                hit = kept.get(key);
                if (hit == null) throw new IllegalStateException("garden read produced no result set");
            }
            try {
                hit.rows().beforeFirst();
                return rse.extractData(hit.rows());
            } catch (SQLException e) {
                throw jdbc.translateException("garden read", sql, e);
            }
        }

        /** Runs one probe in recording mode; whatever stops it (no result yet, a write, a missing row) is not an error here. */
        void probe(Runnable probe) {
            try {
                probe.run();
            } catch (Deferred | RuntimeException stopped) {
                // the real call decides; a probe only says what it would read first
            }
        }

        /** {@link GardenScope#prefetch}: one exchange for the first unread statement of every probe; false when there was none. */
        boolean prefetch(Runnable... probes) {
            if (recording != null) {
                for (Runnable probe : probes) probe(probe);
                return false;
            }
            if (prefetchOff) return false;
            recording = new ArrayList<>();
            List<Pending> pending;
            try {
                for (Runnable probe : probes) probe(probe);
            } finally {
                pending = recording;
                recording = null;
            }
            if (pending.isEmpty()) return false;
            send(pending, false);
            return !prefetchOff;
        }

        /**
         * Sends the statements in as few exchanges as the size limits allow. {@code required}: a failure is the
         * caller's failure (a real read, the lock). Otherwise — a speculative prefetch outside a transaction — a
         * failure only switches prefetching off for this scope: every real call then runs on its own and fails or
         * succeeds exactly where it always did. Inside a transaction a failed statement has ended the transaction on
         * the server, so it is always the caller's failure.
         */
        private void send(List<Pending> pending, boolean required) {
            GardenJdbc jdbc = pending.getFirst().jdbc();
            sync(jdbc);
            if (open.size() > MAX_OPEN) reset(jdbc);
            int from = 0;
            while (from < pending.size()) {
                int to = from;
                int chars = 0;
                while (to < pending.size() && to - from < MAX_STATEMENTS && (to == from || chars + pending.get(to).sql().length() <= MAX_CHARS)) {
                    chars += pending.get(to).sql().length();
                    to++;
                }
                List<Pending> part = pending.subList(from, to);
                try {
                    exchange(jdbc, part);
                } catch (SQLException e) {
                    if (required || holder != null) throw jdbc.translateException("garden read", part.getFirst().sql(), e);
                    alone(jdbc, part);
                }
                from = to;
            }
        }

        /**
         * A speculative exchange failed outside a transaction: find the statement(s) that fail on their own and keep
         * them out of every later exchange; what succeeds is remembered as if the exchange had worked.
         */
        private void alone(GardenJdbc jdbc, List<Pending> part) {
            for (Pending p : part) {
                try {
                    exchange(jdbc, List.of(p));
                } catch (SQLException e) {
                    // only a statement that is wrong in itself (class 42: a missing table or column) is kept apart;
                    // a lost connection or a time-out says nothing about the statement
                    String state = e.getSQLState();
                    if (state != null && state.startsWith("42") && ALONE.size() < 200) {
                        ALONE.put(p.sql(), System.currentTimeMillis() + ALONE_MILLIS);
                    }
                }
            }
        }

        private void reset(GardenJdbc jdbc) {
            reset();
            holder = TransactionSynchronizationManager.getResource(jdbc.obtainDataSource());
            bound = true;
        }

        private void exchange(GardenJdbc jdbc, List<Pending> part) throws SQLException {
            Connection con = connection(jdbc);
            StringBuilder sql = new StringBuilder();
            for (Pending p : part) {
                if (!sql.isEmpty()) sql.append("\n;\n");
                sql.append(strip(p.sql()));
            }
            PreparedStatement ps = con.prepareStatement(sql.toString(), ResultSet.TYPE_SCROLL_INSENSITIVE, ResultSet.CONCUR_READ_ONLY);
            open.add(ps);
            oneShot(ps);
            int offset = 0;
            for (Pending p : part) {
                for (Bind b : p.binds()) replay(ps, con, b, offset);
                offset += p.parameters();
            }
            EXCHANGES.increment();
            if (observer != null) {
                tell("EXCHANGE", part.size() + " statements");
                for (Pending p : part) tell("   ", p.sql());
            }
            boolean rows = ps.execute();
            for (int i = 0; i < part.size(); i++) {
                if (i > 0) rows = ps.getMoreResults(Statement.KEEP_CURRENT_RESULT);
                ResultSet rs = rows ? ps.getResultSet() : null;
                if (rs == null) throw new SQLException("garden exchange: statement " + (i + 1) + " of " + part.size() + " returned no rows object");
                Pending p = part.get(i);
                if (p.keep()) kept.put(p.key(), new Kept(rs, p.words()));
            }
        }

        private void reset() {
            kept.clear();
            for (Statement st : open) {
                try {
                    st.close();
                } catch (SQLException ignored) {
                    // the connection went back to the pool and closed it already
                }
            }
            open.clear();
            if (owned != null) {
                DataSourceUtils.releaseConnection(owned, ownedFrom);
                owned = null;
                ownedFrom = null;
            }
            bound = false;
            holder = null;
        }

        @Override
        public void close() {
            recording = null;
            late.clear(); // a transaction that did not reach its flush is rolling back
            reset();
        }
    }

    // ------------------------------------------------------------------------------------------------ SQL shape

    private static Shape shape(String sql) {
        Shape known = SHAPES.get(sql);
        if (known != null) return known;
        Shape shape = classify(sql);
        if (SHAPES.size() < 4_000) SHAPES.put(sql, shape);
        return shape;
    }

    private static Shape classify(String sql) {
        String text = sql.toLowerCase(Locale.ROOT).strip();
        if (text.contains("pg_advisory") || ROW_LOCK.matcher(text).find()) return new Shape(Kind.OPAQUE, Set.of(), Set.of());
        boolean select = text.startsWith("select") || text.startsWith("with");
        if (WRITE_WORD.matcher(text).find() || !select) {
            Set<String> written = new HashSet<>();
            Matcher m = WRITTEN.matcher(text);
            while (m.find()) if (!m.group(1).equals("set")) written.add(m.group(1));
            return written.isEmpty() ? new Shape(Kind.OPAQUE, Set.of(), Set.of()) : new Shape(Kind.WRITE, Set.of(), Set.copyOf(written));
        }
        if (NOT_REPEATABLE.matcher(text).find() || strip(text).contains(";") || !sourcesKnown(text)) {
            return new Shape(Kind.PLAIN_READ, Set.of(), Set.of());
        }
        Set<String> words = new HashSet<>();
        Matcher m = WORD.matcher(text);
        while (m.find()) words.add(m.group());
        return new Shape(Kind.READ, Set.copyOf(words), Set.of());
    }

    /** Every table the SQL reads is a garden table or one of the read-only learning tables; anything else is not remembered. */
    private static boolean sourcesKnown(String text) {
        Set<String> ctes = new HashSet<>();
        Matcher c = CTE.matcher(text);
        while (c.find()) ctes.add(c.group(1));
        Matcher q = QUALIFIED.matcher(text);
        while (q.find()) {
            String schema = q.group(1);
            if (schema.equals("public") && q.group(3) == null && !known(q.group(2))) return false;
            if (schema.equals("exams") && q.group(2).equals("attempts")) continue; // read by the learning sources, never written here
            if (schema.equals("exams") || schema.equals("information_schema") || schema.equals("pg_catalog")) return false;
        }
        Matcher s = SOURCE.matcher(text);
        while (s.find()) {
            String name = s.group(1);
            String after = s.group(2);
            if (after != null) continue; // schema-qualified (checked above) or a function call
            if (!known(name) && !ctes.contains(name)) return false;
        }
        return true;
    }

    private static boolean known(String table) {
        return table.startsWith("garden_") || FOREIGN_READ_ONLY.contains(table);
    }

    private static String strip(String sql) {
        String s = sql.strip();
        while (s.endsWith(";")) s = s.substring(0, s.length() - 1).stripTrailing();
        return s;
    }

    // ------------------------------------------------------------------------------------------------ parameters

    /** A java.sql.Array asked for while recording; the real array is created on the real connection at send time. */
    private record ArrayStub(String type, Object[] elements) {}

    /** The parameter calls a setter makes, or null when it does anything this class does not replay exactly. */
    private static List<Bind> record(PreparedStatementSetter pss) {
        if (pss == null) return List.of();
        List<Bind> binds = new ArrayList<>();
        boolean[] failed = {false};
        InvocationHandler metadata = (proxy, method, args) -> switch (method.getName()) {
            case "getDriverName" -> "PostgreSQL JDBC Driver";
            case "getDatabaseProductName" -> "PostgreSQL";
            default -> {
                failed[0] = true;
                throw new SQLFeatureNotSupportedException(method.getName());
            }
        };
        InvocationHandler connection = (proxy, method, args) -> switch (method.getName()) {
            case "createArrayOf" -> Proxy.newProxyInstance(GardenJdbc.class.getClassLoader(), new Class<?>[]{java.sql.Array.class, Stub.class},
                    (p, m, a) -> switch (m.getName()) {
                        case "stub" -> new ArrayStub((String) args[0], ((Object[]) args[1]).clone());
                        case "free" -> null;
                        case "toString" -> "garden array stub";
                        case "hashCode" -> System.identityHashCode(p);
                        case "equals" -> p == a[0];
                        default -> {
                            failed[0] = true;
                            throw new SQLFeatureNotSupportedException(m.getName());
                        }
                    });
            case "getMetaData" -> Proxy.newProxyInstance(GardenJdbc.class.getClassLoader(), new Class<?>[]{DatabaseMetaData.class}, metadata);
            default -> {
                failed[0] = true;
                throw new SQLFeatureNotSupportedException(method.getName());
            }
        };
        Connection con = (Connection) Proxy.newProxyInstance(GardenJdbc.class.getClassLoader(), new Class<?>[]{Connection.class}, connection);
        PreparedStatement ps = (PreparedStatement) Proxy.newProxyInstance(GardenJdbc.class.getClassLoader(),
                new Class<?>[]{PreparedStatement.class}, (proxy, method, args) -> {
                    String name = method.getName();
                    if (name.equals("getConnection")) return con;
                    if (SETTERS.contains(name) && args != null && args.length >= 2 && args[0] instanceof Integer) {
                        binds.add(new Bind(method, args.clone()));
                        return null;
                    }
                    failed[0] = true;
                    throw new SQLFeatureNotSupportedException(name);
                });
        try {
            pss.setValues(ps);
        } catch (SQLException | RuntimeException e) {
            return null;
        } finally {
            if (pss instanceof org.springframework.jdbc.core.ParameterDisposer disposer) disposer.cleanupParameters();
        }
        if (failed[0]) return null;
        // every marker 1..n set exactly once, so the statements of one exchange can be numbered one after another
        int n = binds.size();
        boolean[] seen = new boolean[n + 1];
        for (Bind b : binds) {
            int i = (Integer) b.args()[0];
            if (i < 1 || i > n || seen[i]) return null;
            seen[i] = true;
            for (Object a : b.args()) {
                if (a instanceof java.io.InputStream || a instanceof java.io.Reader) return null;
            }
        }
        return binds;
    }

    /** Marker interface of the recorded array proxy. */
    private interface Stub {
        ArrayStub stub();
    }

    private static final Set<String> SETTERS = Set.of("setLong", "setInt", "setShort", "setString", "setBoolean", "setDouble",
            "setFloat", "setBigDecimal", "setTimestamp", "setDate", "setTime", "setObject", "setNull", "setArray", "setBytes");

    private static int parameters(List<Bind> binds) {
        return binds.size();
    }

    private static List<Object> keyOf(List<Bind> binds) {
        List<Object> key = new ArrayList<>(binds.size() * 3);
        for (Bind b : binds) {
            key.add(b.method().getName());
            for (Object a : b.args()) key.add(plain(a));
        }
        return key;
    }

    /** A value with value equality (arrays as lists, a recorded SQL array as its type and elements). */
    private static Object plain(Object value) {
        if (value instanceof Stub s) {
            ArrayStub a = s.stub();
            return Arrays.asList("sql-array", a.type(), plain(a.elements()));
        }
        if (value instanceof Object[] array) {
            List<Object> out = new ArrayList<>(array.length);
            for (Object o : array) out.add(plain(o));
            return out;
        }
        if (value instanceof byte[] bytes) return Arrays.asList("bytes", Arrays.hashCode(bytes), bytes.length, new String(bytes, java.nio.charset.StandardCharsets.ISO_8859_1));
        if (value instanceof java.math.BigDecimal d) return Arrays.asList("decimal", d.toString());
        return value;
    }

    private static void replay(PreparedStatement ps, Connection con, Bind bind, int offset) throws SQLException {
        Object[] args = bind.args().clone();
        args[0] = (Integer) args[0] + offset;
        for (int i = 1; i < args.length; i++) {
            if (args[i] instanceof Stub s) {
                ArrayStub a = s.stub();
                args[i] = con.createArrayOf(a.type(), a.elements());
            }
        }
        try {
            bind.method().invoke(ps, args);
        } catch (java.lang.reflect.InvocationTargetException e) {
            if (e.getCause() instanceof SQLException sql) throw sql;
            throw new SQLException("garden parameter replay failed", e.getCause());
        } catch (IllegalAccessException e) {
            throw new SQLException("garden parameter replay failed", e);
        }
    }

    // ------------------------------------------------------------------------------------------------ driver

    /**
     * Statements of a multi-statement exchange must stay "one shot" for the PostgreSQL driver: once it has described a
     * server-prepared statement with an unbounded column (any text) it refuses to send that statement together with
     * others and forces an exchange per statement. A one-shot statement is parsed on every use (a fraction of a
     * millisecond on the server, against 91 ms saved).
     */
    private static void oneShot(PreparedStatement ps) {
        if (PG_STATEMENT == null || PREPARE_THRESHOLD == null) return;
        try {
            if (ps.isWrapperFor(PG_STATEMENT)) PREPARE_THRESHOLD.invoke(ps.unwrap(PG_STATEMENT), 0);
        } catch (Exception ignored) {
            // another driver: the exchange still works, the driver decides how it travels
        }
    }

    private static Class<?> pgStatement() {
        try {
            return Class.forName("org.postgresql.PGStatement");
        } catch (ClassNotFoundException e) {
            return null;
        }
    }

    private static Method prepareThreshold() {
        try {
            return PG_STATEMENT == null ? null : PG_STATEMENT.getMethod("setPrepareThreshold", int.class);
        } catch (NoSuchMethodException e) {
            return null;
        }
    }
}
