package com.englishcoach.grammar;

import com.englishcoach.grammar.GrammarDtos.ProfessorAnswer;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/** Short transactions only. No provider work is allowed while a connection/owner lock is held. */
@Service
public class GrammarProfessorReceipts {
    public record Ticket(long owner, String requestId, Long reservationId, ProfessorAnswer replay) {}
    private record Row(String hash, String status, String response, boolean interrupted) {}
    private final NamedParameterJdbcTemplate jdbc;
    private final PremiumUsageService usage;
    private final PremiumEntitlementService entitlements;
    private final ObjectMapper mapper;

    public GrammarProfessorReceipts(NamedParameterJdbcTemplate jdbc, PremiumUsageService usage,
                                    PremiumEntitlementService entitlements, ObjectMapper mapper) {
        this.jdbc = jdbc; this.usage = usage; this.entitlements = entitlements; this.mapper = mapper;
    }

    @Transactional
    public Ticket begin(long owner, String requestId, String fingerprint, boolean topicAvailable) {
        var p = params(owner, requestId);
        lock(p);
        var rows = jdbc.query("""
                SELECT request_hash, status, response::text, updated_at < now() - interval '5 minutes'
                FROM public.grammar_professor_receipt
                WHERE user_id=:u AND request_id=:r FOR UPDATE
                """, p, (rs, i) -> new Row(rs.getString(1), rs.getString(2), rs.getString(3), rs.getBoolean(4)));
        if (!rows.isEmpty()) {
            Row row = rows.get(0);
            if (!row.hash().equals(fingerprint)) throw new GrammarException(409, "REQUEST_ID_REUSED");
            if (row.status().equals("COMPLETED")) {
                try { return new Ticket(owner, requestId, null, mapper.readValue(row.response(), ProfessorAnswer.class)); }
                catch (Exception e) { throw new GrammarException(503, "PROFESSOR_UNAVAILABLE"); }
            }
            // Unknown outcomes after a process crash fail closed. Never rerun inference or charge a pending receipt.
            if (row.status().equals("PENDING")) {
                // Both transport attempts normally finish within 96s. After 5min expose uncertainty explicitly,
                // without replaying an unknown call or releasing a hold that could still belong to live work.
                throw new GrammarException(row.interrupted() ? 503 : 409,
                        row.interrupted() ? "PROFESSOR_INTERRUPTED" : "PROFESSOR_IN_PROGRESS");
            }
        }
        if (!topicAvailable) throw new GrammarException(404, "NOT_FOUND");
        Long reservation = usage.reserveUsage(owner, "GRAMMAR_PROFESSOR", UUID.randomUUID().toString(), entitlements.isUserPremium(owner));
        jdbc.update("""
                INSERT INTO public.grammar_professor_receipt(user_id,request_id,request_hash,status,reservation_id)
                VALUES(:u,:r,:hash,'PENDING',:reservation)
                ON CONFLICT(user_id,request_id) DO UPDATE SET status='PENDING',reservation_id=:reservation,
                    response=NULL,updated_at=now()
                """, p.addValue("hash", fingerprint).addValue("reservation", reservation, java.sql.Types.BIGINT));
        return new Ticket(owner, requestId, reservation, null);
    }

    @Transactional
    public void complete(Ticket ticket, ProfessorAnswer answer) {
        String json;
        try { json = mapper.writeValueAsString(answer); }
        catch (Exception e) { throw new GrammarException(503, "PROFESSOR_UNAVAILABLE"); }
        int changed = finish(ticket, "COMPLETED", json);
        if (changed != 1) throw new GrammarException(409, "PROFESSOR_IN_PROGRESS");
        if (ticket.reservationId() != null) usage.commitReservation(ticket.reservationId());
    }

    @Transactional
    public void fail(Ticket ticket) {
        if (finish(ticket, "FAILED", null) == 1 && ticket.reservationId() != null) usage.releaseReservation(ticket.reservationId());
    }

    private int finish(Ticket ticket, String status, String response) {
        var p = params(ticket.owner(), ticket.requestId());
        lock(p);
        return jdbc.update("""
                UPDATE public.grammar_professor_receipt SET status=:status,response=CAST(:response AS jsonb),updated_at=now()
                WHERE user_id=:u AND request_id=:r AND status='PENDING'
                  AND reservation_id IS NOT DISTINCT FROM CAST(:reservation AS bigint)
                """, p.addValue("status", status).addValue("response", response)
                .addValue("reservation", ticket.reservationId(), java.sql.Types.BIGINT));
    }

    private void lock(MapSqlParameterSource p) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended('grammar-professor:' || CAST(:u AS text),0))", p, rs -> {});
    }

    private static MapSqlParameterSource params(long owner, String id) {
        return new MapSqlParameterSource("u", owner).addValue("r", id);
    }
}
