package com.englishcoach.listening.service;

import com.englishcoach.listening.entity.*;
import com.englishcoach.listening.entity.enums.ExerciseType;
import com.englishcoach.listening.repository.*;
import com.englishcoach.premium.service.*;
import com.englishcoach.reading.service.ReadingImportGuard;
import com.englishcoach.reading.service.ReadingService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.*;
import org.springframework.context.event.EventListener;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.http.HttpStatus;
import org.springframework.core.io.Resource;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

@Service
@Slf4j
public class ListeningDocumentService {
    public static final String FEATURE = "LISTENING_DOCUMENT_IMPORT";
    private static final long[] IDLE_BACKOFF_MS = {5_000L, 10_000L, 20_000L, 30_000L};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ReadingService reading;
    private final SpeakingTtsService tts;
    private final ListeningDocumentAudio audio;
    private final ListeningMaterialRepository materials;
    private final TranscriptSegmentRepository segments;
    private final ListeningExerciseRepository exercises;
    private final PremiumUsageService usage;
    private final PremiumEntitlementService entitlement;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.fasterxml.jackson.databind.ObjectMapper objectMapper;
    private long nextCleanup;
    private final Object scheduleLock = new Object();
    private final AtomicBoolean pollRunning = new AtomicBoolean(false);
    private volatile boolean workerStarted;
    private boolean wakeRequested;
    private int idleStep;
    private ScheduledFuture<?> nextPoll;
    // Dedicated single worker: remote TTS never occupies the broker scheduler or a DB transaction.
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r,"listening-document-worker"); t.setDaemon(true); return t;
    });

    public ListeningDocumentService(JdbcTemplate jdbc, PlatformTransactionManager tm, ReadingService reading,
            SpeakingTtsService tts, ListeningDocumentAudio audio, ListeningMaterialRepository materials,
            TranscriptSegmentRepository segments, ListeningExerciseRepository exercises,
            PremiumUsageService usage, PremiumEntitlementService entitlement) {
        this.jdbc=jdbc; this.tx=new TransactionTemplate(tm); this.reading=reading; this.tts=tts; this.audio=audio;
        this.materials=materials; this.segments=segments; this.exercises=exercises; this.usage=usage; this.entitlement=entitlement;
    }
    public record Request(String title,String text,String voiceId) {}
    public record Job(UUID id,String status,Long materialId,String message) {}
    private record Work(UUID id,Long owner,String title,String text,String voice,Long reservation) {}

    public String extract(MultipartFile file, String title) {
        return extract(file, title, null);
    }

    public String extract(MultipartFile file, String title, Long user) {
        validateTitle(title);
        if (file == null || file.isEmpty())
            throw ListeningPassage.bad("Chọn tệp không rỗng.");
        String mime = Objects.toString(file.getContentType(),"").toLowerCase(Locale.ROOT);
        // the shared recognition limits (ReadingImportGuard): PDF 6 MB, PNG / JPG 5 MB
        if (file.getSize() > (mime.equals("application/pdf") ? ReadingImportGuard.MAX_PDF_BYTES : ReadingImportGuard.MAX_IMAGE_BYTES))
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Tệp quá lớn để xử lý (PDF tối đa 6 MB, ảnh PNG/JPG tối đa 5 MB).");
        if (!Set.of("application/pdf","image/png","image/jpeg").contains(mime))
            throw ListeningPassage.bad("Chỉ hỗ trợ PDF, PNG và JPG.");
        try (var input = file.getInputStream()) {
            byte[] h=input.readNBytes(8);
            boolean valid = mime.equals("application/pdf") ? h.length >= 5 && new String(h,0,5,java.nio.charset.StandardCharsets.US_ASCII).equals("%PDF-")
                    : mime.equals("image/png") ? Arrays.equals(h,new byte[]{(byte)137,80,78,71,13,10,26,10})
                    : h.length >= 3 && (h[0]&255)==255 && (h[1]&255)==216 && (h[2]&255)==255;
            if (!valid) throw ListeningPassage.bad("Nội dung tệp không đúng định dạng.");
        } catch (java.io.IOException e) { throw ListeningPassage.bad("Không thể đọc tệp."); }
        Object value=reading.extractFile(file,title,user).get("extracted_text");
        if (!(value instanceof String text) || text.isBlank() || text.length()>100000)
            throw ListeningPassage.bad("Không có văn bản phù hợp hoặc tài liệu quá dài. Chọn tài liệu nhỏ hơn.");
        return text; // Review only: no Reading row, no synthesis, no Listening row.
    }

    public Job create(Long user, Request request) {
        requireUser(user); validateTitle(request.title());
        String text=ListeningPassage.validate(request.text()), voice=request.voiceId();
        if (SpeakingTtsService.CANONICAL_VOICES.stream().noneMatch(v -> v.voiceId().equals(voice)))
            throw ListeningPassage.bad("Giọng đọc không hợp lệ.");
        String fingerprint=ListeningPassage.fingerprint(voice,text);
        Job created = tx.execute(s -> {
            jdbc.execute("SELECT pg_advisory_xact_lock(491914)");
            List<Map<String,Object>> same=jdbc.queryForList("SELECT * FROM public.listening_document_jobs WHERE owner_user_id=? AND fingerprint=?",user,fingerprint);
            if (!same.isEmpty() && !"FAILED".equals(same.getFirst().get("status"))) {
                Job existing=toJob(same.getFirst());
                if ("READY".equals(existing.status())) audio.load(user,existing.id());
                return existing; // completed equivalent imports consume no second usage unit
            }
            if (jdbc.queryForObject("SELECT count(*) FROM public.listening_document_jobs WHERE status IN ('QUEUED','RUNNING')",Long.class)>=8
                    || jdbc.queryForObject("SELECT count(*) FROM public.listening_document_jobs WHERE owner_user_id=? AND status IN ('QUEUED','RUNNING')",Long.class,user)>0)
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Đang có bài nghe được tạo. Vui lòng chờ.");
            if (same.isEmpty() && (jdbc.queryForObject("SELECT count(*) FROM public.listening_document_jobs WHERE owner_user_id=?",Long.class,user)>=20
                    || jdbc.queryForObject("SELECT count(*) FROM public.listening_document_jobs",Long.class)>=200))
                throw new ResponseStatusException(HttpStatus.CONFLICT,"Thư viện tài liệu đã đầy. Xóa bài không dùng trước khi tạo.");
            UUID id=same.isEmpty()?UUID.randomUUID():(UUID)same.getFirst().get("id");
            if (jdbc.queryForObject("SELECT count(*) FROM public.premium_feature_definitions WHERE feature_key=? AND enabled=true",Long.class,FEATURE)!=1)
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Chức năng tạo bài nghe chưa sẵn sàng.");
            // Reserve here, not in an interceptor that would charge an accepted HTTP 202 as completed audio.
            Long reservation=usage.reserveUsage(user,FEATURE,UUID.randomUUID().toString(),entitlement.isUserPremium(user));
            if (same.isEmpty()) jdbc.update("INSERT INTO public.listening_document_jobs(id,owner_user_id,fingerprint,title,confirmed_text,voice_id,status,reservation_id) VALUES (?,?,?,?,?,?,'QUEUED',?)",
                    id,user,fingerprint,request.title().trim(),text,voice,reservation);
            else jdbc.update("UPDATE public.listening_document_jobs SET title=?,status='QUEUED',reservation_id=?,updated_at=now() WHERE id=? AND owner_user_id=?",
                    request.title().trim(),reservation,id,user);
            return new Job(id,"QUEUED",null,null);
        });
        if (created != null && "QUEUED".equals(created.status())) {
            wakePoller();
        }
        return created;
    }
    public Job get(Long user,UUID id) {
        requireUser(user);
        return jdbc.queryForList("SELECT id,status,material_id FROM public.listening_document_jobs WHERE id=? AND owner_user_id=?",id,user)
                .stream().findFirst().map(this::toJob).orElseThrow(ListeningDocumentService::missing);
    }
    public Resource media(Long user,Long materialId) {
        requireUser(user);
        var rows=jdbc.queryForList("SELECT j.id FROM public.listening_document_jobs j JOIN public.listening_materials m ON m.id=j.material_id WHERE j.material_id=? AND j.owner_user_id=? AND m.owner_user_id=? AND m.is_system=false AND m.source_type='DOCUMENT' AND j.status='READY'",materialId,user,user);
        if(rows.isEmpty()) throw missing();
        return audio.load(user,(UUID)rows.getFirst().get("id"));
    }
    public void deleteAudioAfterCommit(Long materialId) {
        var rows=jdbc.queryForList("SELECT id,owner_user_id FROM public.listening_document_jobs WHERE material_id=?",materialId);
        if(rows.isEmpty()) return;
        UUID id=(UUID)rows.getFirst().get("id"); Long owner=((Number)rows.getFirst().get("owner_user_id")).longValue();
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { try { audio.delete(owner,id); } catch(Exception e) { log.warn("Document audio cleanup pending for job {}",id); } }
        });
    }

    @EventListener(ApplicationReadyEvent.class)
    public void startWorker() {
        // A process interruption is retryable, never a falsely READY material or stranded quota.
        tx.executeWithoutResult(s -> {
            var interrupted=jdbc.queryForList("SELECT id,owner_user_id,reservation_id FROM public.listening_document_jobs WHERE status='RUNNING'");
            for(var row:interrupted) {
                usage.releaseReservation(number(row.get("reservation_id")));
                audio.delete(number(row.get("owner_user_id")),(UUID)row.get("id"));
            }
            jdbc.update("UPDATE public.listening_document_jobs SET status='FAILED',updated_at=now() WHERE status='RUNNING'");
        });
        synchronized (scheduleLock) {
            workerStarted = true;
            idleStep = 0;
            nextPoll = worker.schedule(this::pollLoop, IDLE_BACKOFF_MS[0], TimeUnit.MILLISECONDS);
        }
    }

    /** Immediately resets idle backoff and wakes the document worker when a new job is enqueued. */
    public void wakePoller() {
        synchronized (scheduleLock) {
            idleStep = 0;
            if (!workerStarted || worker.isShutdown()) return;
            if (pollRunning.get()) {
                wakeRequested = true;
                return;
            }
            if (nextPoll != null) nextPoll.cancel(false);
            nextPoll = worker.schedule(this::pollLoop, 0L, TimeUnit.MILLISECONDS);
        }
    }

    @PreDestroy public void stopWorker() {
        synchronized (scheduleLock) {
            workerStarted = false;
            if (nextPoll != null) nextPoll.cancel(false);
        }
        worker.shutdownNow();
    }

    private void pollLoop() {
        pollRunning.set(true);
        boolean foundWork = false;
        try {
            foundWork = tickAndReport();
        } finally {
            pollRunning.set(false);
            synchronized (scheduleLock) {
                if (workerStarted && !worker.isShutdown()) {
                    long delayMs;
                    if (foundWork || wakeRequested) {
                        wakeRequested = false;
                        idleStep = 0;
                        delayMs = foundWork ? 250L : 0L;
                    } else {
                        delayMs = IDLE_BACKOFF_MS[Math.min(idleStep, IDLE_BACKOFF_MS.length - 1)];
                        if (idleStep < IDLE_BACKOFF_MS.length - 1) idleStep++;
                    }
                    nextPoll = worker.schedule(this::pollLoop, delayMs, TimeUnit.MILLISECONDS);
                }
            }
        }
    }

    void tick() {
        tickAndReport();
    }

    private boolean tickAndReport() {
        try {
            if (System.currentTimeMillis() >= nextCleanup) {
                // Failed drafts have a bounded retention window; completed audio lives until explicit deletion.
                var expired=jdbc.queryForList("DELETE FROM public.listening_document_jobs WHERE status='FAILED' AND updated_at < now() - interval '7 days' RETURNING id,owner_user_id");
                for(var r:expired) audio.delete(number(r.get("owner_user_id")),(UUID)r.get("id"));
                nextCleanup=System.currentTimeMillis()+3600000;
            }
            Work work=tx.execute(s -> {
                var rows=jdbc.queryForList("SELECT * FROM public.listening_document_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED");
                if(rows.isEmpty()) return null;
                var r=rows.getFirst(); UUID id=(UUID)r.get("id");
                jdbc.update("UPDATE public.listening_document_jobs SET status='RUNNING',updated_at=now() WHERE id=?",id);
                return new Work(id,number(r.get("owner_user_id")),(String)r.get("title"),(String)r.get("confirmed_text"),(String)r.get("voice_id"),number(r.get("reservation_id")));
            });
            if(work!=null) {
                generate(work);
                return true;
            }
        } catch(Exception e) { log.warn("Listening document worker could not settle a job ({})",e.getClass().getSimpleName()); }
        return false;
    }
    private void generate(Work w) {
        try {
            List<String> text=ListeningPassage.segments(w.text());
            List<ListeningDocumentAudio.Chunk> chunks=new ArrayList<>(); long byteCount=0; long started=System.nanoTime();
            for(String sentence:text) {
                if(Thread.currentThread().isInterrupted() || TimeUnit.NANOSECONDS.toSeconds(System.nanoTime()-started)>240)
                    throw new IllegalStateException("Generation deadline");
                var chunk=audio.decode(tts.synthesizePrivatePassage(w.voice(),sentence));
                byteCount+=chunk.pcm().length;
                if(byteCount>24*1024*1024) throw new IllegalStateException("Audio bound");
                chunks.add(chunk);
            }
            audio.save(w.owner(),w.id(),chunks);
            tx.executeWithoutResult(s -> {
                long totalFrames=chunks.stream().mapToLong(ListeningDocumentAudio.Chunk::frames).sum();
                double rate=chunks.getFirst().format().getFrameRate();
                ListeningMaterial material=materials.saveAndFlush(ListeningMaterial.builder().title(w.title()).sourceType("DOCUMENT")
                        .voiceId(w.voice()).ownerUserId(w.owner()).isSystem(false).audioUrl("pending")
                        .accent(w.voice().startsWith("us_")?"American":"British").speakerCount(1)
                        .durationSeconds((int)Math.ceil(totalFrames/rate)).build());
                material.setAudioUrl("/api/v1/listening/materials/"+material.getId()+"/audio");
                persistDocumentSegmentsAndExercisesBatch(material, text, chunks, rate);
                materials.saveAndFlush(material);
                jdbc.update("UPDATE public.listening_document_jobs SET status='READY',material_id=?,updated_at=now() WHERE id=? AND status='RUNNING'",material.getId(),w.id());
                usage.commitReservation(w.reservation());
            });
        } catch(Exception e) {
            log.warn("Document generation failed for job {} ({})",w.id(),e.getClass().getSimpleName());
            Boolean failed=tx.execute(s -> {
                int changed=jdbc.update("UPDATE public.listening_document_jobs SET status='FAILED',updated_at=now() WHERE id=? AND status='RUNNING'",w.id());
                if(changed==1) usage.releaseReservation(w.reservation());
                return changed==1;
            });
            if(Boolean.TRUE.equals(failed)) audio.delete(w.owner(),w.id());
        }
    }

    /**
     * R13: Persist all document transcript segments and dictation exercises in one single JDBC CTE batch exchange
     * (matching ListeningTranscriptWriter) instead of 2N per-sentence round trips.
     */
    private void persistDocumentSegmentsAndExercisesBatch(
            ListeningMaterial material,
            List<String> text,
            List<ListeningDocumentAudio.Chunk> chunks,
            double rate
    ) {
        if (text.isEmpty()) return;
        if (objectMapper != null) {
            List<Map<String, Object>> rows = new ArrayList<>(text.size());
            long offset = 0;
            for (int i = 0; i < text.size(); i++) {
                int start = (int) Math.round(offset * 1000d / rate);
                offset += chunks.get(i).frames();
                int end = (int) Math.round(offset * 1000d / rate);
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("position", i);
                row.put("start_ms", start);
                row.put("end_ms", end);
                row.put("text", text.get(i));
                rows.add(row);
            }
            final String payload;
            try {
                payload = objectMapper.writeValueAsString(rows);
            } catch (Exception e) {
                throw new IllegalStateException("Cannot serialize document segments", e);
            }
            var ids = jdbc.queryForList("""
                WITH input AS MATERIALIZED (
                    SELECT nextval(pg_get_serial_sequence('public.transcript_segments','id')) AS id, x.*
                    FROM jsonb_to_recordset(CAST(? AS jsonb)) AS x(position int, start_ms int, end_ms int, text text)
                ), saved AS (
                    INSERT INTO public.transcript_segments(id, listening_material_id, start_time_ms, end_time_ms, text)
                    SELECT id, ?, start_ms, end_ms, text FROM input RETURNING id
                ), exercises AS (
                    INSERT INTO public.listening_exercises(listening_material_id, transcript_segment_id, exercise_type, question_text, expected_answer)
                    SELECT ?, i.id, 'DICTATION', 'Nghe và nhập nội dung câu.', i.text
                    FROM input i JOIN saved s ON s.id = i.id RETURNING id
                )
                SELECT i.id, i.position FROM input i JOIN saved s ON s.id = i.id
                WHERE (SELECT count(*) FROM exercises) = (SELECT count(*) FROM input) ORDER BY i.position
                """, payload, material.getId(), material.getId());
            if (ids.size() != text.size()) {
                throw new IllegalStateException("Incomplete document transcript write");
            }
            return;
        }

        // Fallback when constructed outside Spring (e.g., focused tests with mocked JPA repositories)
        List<TranscriptSegment> segmentBatch = new ArrayList<>(text.size());
        long offset = 0;
        for (int i = 0; i < text.size(); i++) {
            int start = (int) Math.round(offset * 1000d / rate);
            offset += chunks.get(i).frames();
            segmentBatch.add(TranscriptSegment.builder()
                    .listeningMaterial(material)
                    .text(text.get(i))
                    .startTimeMs(start)
                    .endTimeMs((int) Math.round(offset * 1000d / rate))
                    .build());
        }
        List<TranscriptSegment> savedSegments = segments.saveAll(segmentBatch);
        if (savedSegments != null && savedSegments.size() == segmentBatch.size()) {
            List<ListeningExercise> exerciseBatch = new ArrayList<>(savedSegments.size());
            for (TranscriptSegment seg : savedSegments) {
                exerciseBatch.add(ListeningExercise.builder()
                        .listeningMaterial(material)
                        .transcriptSegment(seg)
                        .exerciseType(ExerciseType.DICTATION)
                        .questionText("Nghe và nhập nội dung câu.")
                        .expectedAnswer(seg.getText())
                        .build());
            }
            List<ListeningExercise> savedExercises = exercises.saveAll(exerciseBatch);
            if (savedExercises != null && savedExercises.size() == exerciseBatch.size()) {
                return;
            }
            for (ListeningExercise ex : exerciseBatch) {
                exercises.save(ex);
            }
            return;
        }
        for (TranscriptSegment seg : segmentBatch) {
            TranscriptSegment savedSeg = segments.save(seg);
            exercises.save(ListeningExercise.builder()
                    .listeningMaterial(material)
                    .transcriptSegment(savedSeg)
                    .exerciseType(ExerciseType.DICTATION)
                    .questionText("Nghe và nhập nội dung câu.")
                    .expectedAnswer(seg.getText())
                    .build());
        }
    }
    private Job toJob(Map<String,Object> row) { return new Job((UUID)row.get("id"),(String)row.get("status"),number(row.get("material_id")),
            "FAILED".equals(row.get("status"))?"Chưa thể tạo bài nghe. Nội dung đã giữ lại; bạn có thể thử lại.":null); }
    private static Long number(Object n) { return n==null?null:((Number)n).longValue(); }
    private static void validateTitle(String title) { if(title==null || title.isBlank() || title.length()>200) throw ListeningPassage.bad("Tiêu đề bài nghe cần có từ 1 đến 200 ký tự."); }
    private static void requireUser(Long user) { if(user==null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Vui lòng đăng nhập."); }
    private static ResponseStatusException missing() { return new ResponseStatusException(HttpStatus.NOT_FOUND,"Không tìm thấy bài nghe."); }
}
