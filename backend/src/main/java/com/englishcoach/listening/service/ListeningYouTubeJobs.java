package com.englishcoach.listening.service;

import com.englishcoach.listening.dto.ImportListeningMaterialRequest;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.fasterxml.jackson.databind.*;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.*;
import org.springframework.web.server.ResponseStatusException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Durable owner-scoped receipts; the worker never holds a database connection during a GPU/network wait. */
@Service
@Slf4j
public class ListeningYouTubeJobs {
    static final String FEATURE="LISTENING_YOUTUBE_IMPORT";
    private static final long ACTIVE_POLL_MS = 3_000L;
    private static final long[] IDLE_BACKOFF_MS = {3_000L, 10_000L, 30_000L};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final ObjectMapper mapper;
    private final ListeningServiceImpl listening;
    private final PremiumUsageService usage;
    private final PremiumEntitlementService entitlement;
    private final RestTemplate gpu;
    @org.springframework.beans.factory.annotation.Autowired(required=false)
    private com.englishcoach.premium.voucher.AiVoucherService vouchers;
    @Value("${ai.base-url:http://localhost:8000}") private String aiBase;
    private long nextCleanup;
    private final Object scheduleLock = new Object();
    private final AtomicBoolean pollRunning = new AtomicBoolean(false);
    private volatile boolean workerStarted;
    private boolean wakeRequested;
    private int idleStep;
    private ScheduledFuture<?> nextPoll;
    private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t=new Thread(r,"listening-youtube-jobs"); t.setDaemon(true); return t;
    });
    public ListeningYouTubeJobs(JdbcTemplate jdbc,PlatformTransactionManager tm,ObjectMapper mapper,
            ListeningServiceImpl listening,PremiumUsageService usage,PremiumEntitlementService entitlement) {
        this.jdbc=jdbc;this.tx=new TransactionTemplate(tm);this.mapper=mapper;this.listening=listening;
        this.usage=usage;this.entitlement=entitlement;
        var f=new com.englishcoach.common.ai.AiServiceRequestFactory(); f.setConnectTimeout(2000);f.setReadTimeout(5000);
        this.gpu=new RestTemplate(f);
    }
    public record Job(UUID id,String status,String stage,Long materialId,String message,String updatedAt) {}

    public Job create(Long user,ImportListeningMaterialRequest request) {
        requireUser(user);
        String video=videoId(request.getYoutubeUrl());
        request.setYoutubeUrl("https://www.youtube.com/watch?v="+video);
        check(request.getTitle(),255);check(request.getTopic(),100);check(request.getAccent(),50);check(request.getChannel(),255);
        if(request.getCefrLevel()!=null && !Set.of("A1","A2","B1","B2","C1","C2").contains(request.getCefrLevel())) throw bad("Cấp độ không hợp lệ.");
        String json=encode(request),fingerprint=hash(json);
        if(json.length()>4096) throw bad("Thông tin import quá dài.");
        Job created;
        try { created = createReceipt(user,request,json,fingerprint,null); }
        catch(com.englishcoach.premium.exception.PremiumRequiredException | com.englishcoach.premium.exception.PremiumLimitReachedException exhausted) {
            if(vouchers==null) throw exhausted;
            // The refused quota transaction has already rolled back. Voucher reservation and receipt now share ONE new transaction.
            created = createReceipt(user,request,json,fingerprint,exhausted);
        }
        if (created != null && Set.of("QUEUED","RUNNING","SAVING").contains(created.status())) {
            wakePoller();
        }
        return created;
    }
    private Job createReceipt(Long user,ImportListeningMaterialRequest request,String json,String fingerprint,RuntimeException exhausted) {
        return tx.execute(s -> {
            // Bounds and per-owner idempotency are decided atomically before quota or dispatch.
            jdbc.execute("SELECT pg_advisory_xact_lock(491915)");
            var same=jdbc.queryForList("SELECT * FROM public.listening_youtube_jobs WHERE owner_user_id=? AND fingerprint=?",user,fingerprint);
            if(!same.isEmpty() && !Set.of("FAILED","CANCELLED").contains(same.getFirst().get("status"))) return view(same.getFirst());
            Long active=jdbc.queryForObject("SELECT count(*) FROM public.listening_youtube_jobs WHERE status IN ('QUEUED','RUNNING','SAVING')",Long.class);
            Long own=jdbc.queryForObject("SELECT count(*) FROM public.listening_youtube_jobs WHERE owner_user_id=? AND status IN ('QUEUED','RUNNING','SAVING')",Long.class,user);
            if(active>=8 || own>0) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"Đang có bài nghe được xử lý. Vui lòng chờ.");
            if(same.isEmpty() && jdbc.queryForObject("SELECT count(*) FROM public.listening_youtube_jobs",Long.class)>=1000)
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"Hàng đợi import đang đầy. Vui lòng thử lại sau.");
            if(!same.isEmpty() && !Boolean.TRUE.equals(same.getFirst().get("cancel_ack"))) return view(same.getFirst());
            UUID id=same.isEmpty()?UUID.randomUUID():(UUID)same.getFirst().get("id");
            UUID engine=UUID.randomUUID();
            Long reservation=null,voucher=null;
            if(exhausted==null) reservation=usage.reserveUsage(user,FEATURE,engine.toString(),entitlement.isUserPremium(user));
            else { voucher=vouchers.reserve(user,FEATURE,engine.toString()); if(voucher==null) throw exhausted; }
            if(same.isEmpty()) jdbc.update("""
                INSERT INTO public.listening_youtube_jobs(id,owner_user_id,fingerprint,engine_id,request_json,status,stage,reservation_id,voucher_use_id)
                VALUES(?,?,?,?,?,'QUEUED','QUEUED',?,?)
                """,id,user,fingerprint,engine,json,reservation,voucher);
            else jdbc.update("""
                UPDATE public.listening_youtube_jobs SET engine_id=?,status='QUEUED',stage='QUEUED',reservation_id=?,voucher_use_id=?,message=NULL,
                transport_failures=0,cancel_ack=false,created_at=now(),updated_at=now() WHERE id=? AND owner_user_id=?
                """,engine,reservation,voucher,id,user);
            return get(user,id);
        });
    }
    public Job get(Long user,UUID id) {
        requireUser(user);
        return jdbc.queryForList("SELECT * FROM public.listening_youtube_jobs WHERE id=? AND owner_user_id=?",id,user)
            .stream().findFirst().map(this::view).orElseThrow(ListeningYouTubeJobs::missing);
    }
    public List<Job> recent(Long user) {
        requireUser(user);
        return jdbc.queryForList("SELECT * FROM public.listening_youtube_jobs WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 12",user)
            .stream().map(this::view).toList();
    }
    public Job cancel(Long user,UUID id) {
        requireUser(user);
        Job cancelled = tx.execute(s -> {
            var rows=jdbc.queryForList("SELECT * FROM public.listening_youtube_jobs WHERE id=? AND owner_user_id=? FOR UPDATE",id,user);
            if(rows.isEmpty()) throw missing();
            var r=rows.getFirst();
            if(Set.of("QUEUED","RUNNING","SAVING").contains(r.get("status"))) {
                jdbc.update("UPDATE public.listening_youtube_jobs SET status='CANCELLED',stage='CANCELLED',updated_at=now() WHERE id=? AND owner_user_id=?",id,user);
                usage.releaseReservation(number(r.get("reservation_id")));
                if(vouchers!=null) vouchers.release(number(r.get("voucher_use_id")));
            }
            return get(user,id);
        });
        wakePoller();
        return cancelled;
    }
    @EventListener(ApplicationReadyEvent.class) public void start() {
        // Persisted RUNNING/SAVING receipts reattach to the same PC UUID after a backend restart.
        synchronized (scheduleLock) {
            workerStarted = true;
            idleStep = 0;
            nextPoll = worker.schedule(this::pollLoop, 1_000L, TimeUnit.MILLISECONDS);
        }
    }
    /** Immediately resets idle backoff and wakes the YouTube job poller when a job is enqueued or cancelled. */
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
    @PreDestroy public void stop(){
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
                    if (wakeRequested) {
                        wakeRequested = false;
                        idleStep = 0;
                        delayMs = 0L;
                    } else if (foundWork) {
                        idleStep = 0;
                        delayMs = ACTIVE_POLL_MS;
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
            if(System.currentTimeMillis()>=nextCleanup) {
                jdbc.update("DELETE FROM public.listening_youtube_jobs WHERE status IN ('READY','FAILED','CANCELLED') AND updated_at<now()-interval '7 days'");
                nextCleanup=System.currentTimeMillis()+3600000;
            }
            var work=jdbc.queryForList("""
                SELECT *,created_at<now()-interval '20 minutes' AS expired FROM public.listening_youtube_jobs
                WHERE status IN ('QUEUED','RUNNING','SAVING') OR (status IN ('CANCELLED','FAILED') AND NOT cancel_ack)
                ORDER BY created_at LIMIT 16
                """);
            for(var r:work) process(r);
            return !work.isEmpty();
        } catch(Exception e){log.warn("Listening job tick failed ({})",e.getClass().getSimpleName());}
        return false;
    }
    private String endpoint(UUID engine){return aiBase.replaceAll("/+$","")+"/api/v1/listening/jobs/"+engine;}
    private void process(Map<String,Object> row) {
        UUID id=(UUID)row.get("id"),engine=(UUID)row.get("engine_id");
        try {
            if(Set.of("CANCELLED","FAILED").contains(row.get("status"))) {
                gpu.delete(endpoint(engine));
                jdbc.update("UPDATE public.listening_youtube_jobs SET cancel_ack=true WHERE id=? AND engine_id=?",id,engine);return;
            }
            if(Boolean.TRUE.equals(row.get("expired"))) {
                gpu.delete(endpoint(engine));fail(id,engine,"Tác vụ quá thời gian xử lý. Vui lòng thử lại.");return;
            }
            JsonNode state;
            try {state=gpu.getForObject(endpoint(engine),JsonNode.class);}
            catch(HttpClientErrorException.NotFound e) {
                var request=mapper.readValue((String)row.get("request_json"),ImportListeningMaterialRequest.class);
                state=gpu.postForObject(endpoint(engine),Map.of("youtubeUrl",request.getYoutubeUrl()),JsonNode.class);
            }
            if(state==null) throw new IllegalStateException("Empty PC receipt");
            String status=state.path("status").asText();
            if("READY".equals(status)) {
                JsonNode result=gpu.getForObject(endpoint(engine)+"/result",JsonNode.class);
                if(result==null || !result.has("result")) throw new IllegalStateException("Missing PC result");
                jdbc.update("UPDATE public.listening_youtube_jobs SET status='SAVING',stage='persistence',updated_at=now() WHERE id=? AND engine_id=? AND status IN ('QUEUED','RUNNING','SAVING')",id,engine);
                long started=System.nanoTime();
                tx.executeWithoutResult(s -> {
                    var locked=jdbc.queryForList("SELECT * FROM public.listening_youtube_jobs WHERE id=? AND engine_id=? FOR UPDATE",id,engine);
                    if(locked.isEmpty() || !"SAVING".equals(locked.getFirst().get("status"))) return;
                    var r=locked.getFirst();
                    ImportListeningMaterialRequest request;
                    try {request=mapper.readValue((String)r.get("request_json"),ImportListeningMaterialRequest.class);}
                    catch(Exception e){throw new IllegalStateException(e);}
                    var material=listening.persistVerifiedJob(request,number(r.get("owner_user_id")),result.get("result"));
                    usage.commitReservation(number(r.get("reservation_id")));
                    if(vouchers!=null) vouchers.consume(number(r.get("voucher_use_id")));
                    jdbc.update("UPDATE public.listening_youtube_jobs SET status='READY',stage='READY',material_id=?,updated_at=now() WHERE id=? AND engine_id=?",material.getId(),id,engine);
                });
                log.info("listening_timing job={} stage=persist_commit elapsedMs={}",id,(System.nanoTime()-started)/1_000_000);
            } else if(Set.of("FAILED","CANCELLED").contains(status)) {
                fail(id,engine,state.path("message").asText("Máy xử lý chưa hoàn tất. Vui lòng thử lại."));
            } else {
                String stage=state.path("stage").asText("QUEUED");
                if(!Set.of("QUEUED","metadata","captions","caption_fallback","audio_download","audio_decode","transcription","alignment","validation").contains(stage)) stage="QUEUED";
                jdbc.update("""
                    UPDATE public.listening_youtube_jobs SET status=?,stage=?,transport_failures=0,updated_at=now()
                    WHERE id=? AND engine_id=? AND status IN ('QUEUED','RUNNING','SAVING')
                    ""","QUEUED".equals(status)?"QUEUED":"RUNNING",stage,id,engine);
            }
        } catch(RestClientException e) {
            jdbc.update("UPDATE public.listening_youtube_jobs SET transport_failures=transport_failures+1 WHERE id=? AND engine_id=?",id,engine);
            if(((Number)row.get("transport_failures")).intValue()>=9) {
                // Keep cancellation pending in the worker until the PC acknowledges it; never silently orphan work.
                fail(id,engine,"Không kết nối được máy xử lý. Vui lòng thử lại sau.");
                try{gpu.delete(endpoint(engine));}catch(RestClientException ignored){}
            }
        } catch(Exception e) {
            log.warn("Listening job {} failed ({})",id,e.getClass().getSimpleName());
            fail(id,engine,"Không thể hoàn tất bài nghe. Vui lòng thử lại.");
        }
    }
    private void fail(UUID id,UUID engine,String message) {
        tx.executeWithoutResult(s -> {
            var rows=jdbc.queryForList("SELECT reservation_id,voucher_use_id FROM public.listening_youtube_jobs WHERE id=? AND engine_id=? AND status IN ('QUEUED','RUNNING','SAVING') FOR UPDATE",id,engine);
            if(rows.isEmpty()) return;
            usage.releaseReservation(number(rows.getFirst().get("reservation_id")));
            if(vouchers!=null) vouchers.release(number(rows.getFirst().get("voucher_use_id")));
            jdbc.update("UPDATE public.listening_youtube_jobs SET status='FAILED',stage='FAILED',message=?,updated_at=now() WHERE id=? AND engine_id=?",message.substring(0,Math.min(500,message.length())),id,engine);
        });
    }
    private Job view(Map<String,Object> r){return new Job((UUID)r.get("id"),(String)r.get("status"),(String)r.get("stage"),number(r.get("material_id")),(String)r.get("message"),r.get("updated_at").toString());}
    private String encode(Object value){try{return mapper.writeValueAsString(value);}catch(Exception e){throw bad("Thông tin import không hợp lệ.");}}
    private static String hash(String s){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}}
    private static Long number(Object o){return o==null?null:((Number)o).longValue();}
    private static void check(String s,int max){if(s!=null && s.length()>max)throw bad("Thông tin import quá dài.");}
    private static void requireUser(Long user){if(user==null)throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"Vui lòng đăng nhập.");}
    private static ResponseStatusException missing(){return new ResponseStatusException(HttpStatus.NOT_FOUND,"Không tìm thấy tác vụ.");}
    private static ResponseStatusException bad(String message){return new ResponseStatusException(HttpStatus.BAD_REQUEST,message);}
    static String videoId(String raw) {
        if(raw==null || raw.length()>2048) throw bad("Đường dẫn YouTube không hợp lệ.");
        String text=raw.trim(),id=null;
        if(text.matches("[A-Za-z0-9_-]{11}")) return text;
        try {
            URI uri=URI.create(text);
            String host=Objects.toString(uri.getHost(),"").toLowerCase(Locale.ROOT);
            if(!Set.of("http","https").contains(uri.getScheme()) || uri.getUserInfo()!=null || uri.getPort()!=-1) throw bad("Đường dẫn YouTube không hợp lệ.");
            String path=Objects.toString(uri.getPath(),"");
            if(Set.of("youtu.be","www.youtu.be").contains(host)) id=path.substring(1);
            else if(Set.of("youtube.com","www.youtube.com","m.youtube.com","music.youtube.com","youtube-nocookie.com","www.youtube-nocookie.com").contains(host)) {
                if("/watch".equals(path)) {
                    for(String q:Objects.toString(uri.getRawQuery(),"").split("&")) if(q.startsWith("v=")) id=q.substring(2);
                } else if(path.matches("/(embed|shorts|live|v)/[A-Za-z0-9_-]{11}")) id=path.substring(path.lastIndexOf('/')+1);
            }
        } catch(IllegalArgumentException|IndexOutOfBoundsException e){throw bad("Đường dẫn YouTube không hợp lệ.");}
        if(id==null || !id.matches("[A-Za-z0-9_-]{11}"))throw bad("Đường dẫn YouTube không hợp lệ.");
        return id;
    }
}
