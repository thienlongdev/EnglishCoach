package com.englishcoach.grammar;

import com.englishcoach.grammar.GrammarDtos.ProfessorAnswer;
import com.englishcoach.grammar.GrammarDtos.ProfessorRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

/** Explicit question → owner/content-bound receipt → provider outside a transaction → atomic result/quota commit. */
@Service
public class GrammarProfessorFacade {
    private final GrammarContent content;
    private final GrammarProfessorService provider;
    private final GrammarProfessorReceipts receipts;
    private final ObjectMapper mapper;
    private final GrammarProfessorAvailability availability;

    public GrammarProfessorFacade(GrammarContent content, GrammarProfessorService provider,
                                  GrammarProfessorReceipts receipts, ObjectMapper mapper, GrammarProfessorAvailability availability) {
        this.content = content; this.provider = provider; this.receipts = receipts; this.mapper = mapper;
        this.availability = availability;
    }

    public boolean available() { return availability.available(); }

    public ProfessorAnswer ask(long owner, String requestId, ProfessorRequest request) {
        // Owner correction: disabled AI must reject BEFORE receipt lookup/reservation or provider work, including replay.
        if (!available()) throw new GrammarException(503, "PROFESSOR_DISABLED");
        String id = requestId == null || requestId.isBlank() ? UUID.randomUUID().toString() : requestId.trim();
        if (id.length() > 128) throw new GrammarException(400, "INVALID_REQUEST");
        String fingerprint;
        try {
            fingerprint = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(
                    List.of(request.topic(), request.question(), request.sentence() == null ? "" : request.sentence()))));
        } catch (Exception e) { throw new GrammarException(400, "INVALID_REQUEST"); }
        // Existing completed receipts survive curriculum changes; new executions require a current curated topic.
        var ticket = receipts.begin(owner, id, fingerprint, content.meta(request.topic()).isPresent());
        if (ticket.replay() != null) return ticket.replay();
        ProfessorAnswer answer;
        try { answer = provider.ask(request); }
        catch (RuntimeException failed) { receipts.fail(ticket); throw failed; }
        // Do not mark this as a provider failure if persistence failed: its outcome is uncertain, so retries fail closed.
        receipts.complete(ticket, answer);
        return answer;
    }
}
