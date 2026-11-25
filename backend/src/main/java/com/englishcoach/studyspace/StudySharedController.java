package com.englishcoach.studyspace;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echolife.EchoLifeBulkhead;
import com.englishcoach.echolife.EchoLifeException;
import com.englishcoach.echolife.EchoLifeGameService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
@RestController @RequestMapping("/api/v1/study-space/shared")
public class StudySharedController {
    private static final int EVENT_RATE_LIMIT = 6;
    private static final long EVENT_RATE_WINDOW_MS = 60_000L;
    private static final int MAX_TRACKED_USERS = 4096;

    private final StudySharedService service;
    private final EchoLifeGameService games;
    private final EchoLifeBulkhead bulkhead;
    private final ConcurrentHashMap<Long, long[]> eventInviteRates = new ConcurrentHashMap<>();

    public StudySharedController(StudySharedService service, EchoLifeGameService games) {
        this(service, games, new EchoLifeBulkhead(0, 1000L));
    }

    @Autowired
    public StudySharedController(StudySharedService service, EchoLifeGameService games, ObjectProvider<EchoLifeBulkhead> bulkhead) {
        this(service, games, bulkhead.getIfAvailable(() -> new EchoLifeBulkhead(0, 1000L)));
    }

    StudySharedController(StudySharedService service, EchoLifeGameService games, EchoLifeBulkhead bulkhead) {
        this.service = service;
        this.games = games;
        this.bulkhead = bulkhead != null ? bulkhead : new EchoLifeBulkhead(0, 1000L);
    }

    @PostMapping("/{id}/events/{eventId}")
    public ResponseEntity<?> inviteToEvent(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id,@PathVariable String eventId){
        long learner=owner(u);
        enforceEventInviteRateLimit(learner);
        try {
            return ok(bulkhead.execute(() -> service.inviteToEvent(learner,id,eventId,()->games.attendedEvent(learner,eventId))));
        } catch (EchoLifeException e) {
            String code = e.getMessage() != null && !e.getMessage().isBlank() ? e.getMessage() : "ECHO_LIFE_BUSY";
            int status = "ECHO_LIFE_BUSY".equals(code) ? 503 : 400;
            throw new StudySpaceException(status, code);
        }
    }

    private void enforceEventInviteRateLimit(long learner) {
        long now = System.currentTimeMillis();
        if (eventInviteRates.size() > MAX_TRACKED_USERS) {
            eventInviteRates.entrySet().removeIf(e -> now - e.getValue()[0] > EVENT_RATE_WINDOW_MS);
        }
        boolean[] allowed = { false };
        eventInviteRates.compute(learner, (uid, state) -> {
            if (state == null || now - state[0] >= EVENT_RATE_WINDOW_MS) {
                allowed[0] = true;
                return new long[] { now, 1L };
            }
            if (state[1] >= EVENT_RATE_LIMIT) {
                return state;
            }
            allowed[0] = true;
            return new long[] { state[0], state[1] + 1L };
        });
        if (!allowed[0]) {
            throw new StudySpaceException(429, "EVENT_RATE_LIMIT");
        }
    }
    public record Create(String name,int capacity){} public record Join(String invite){} public record Timer(String action,Integer minutes,long revision){} public record Moderate(long participant,String action){}
    private long owner(UserDetailsImpl u){if(u==null||u.getId()==null)throw new StudySpaceException(401,"AUTH_REQUIRED");return u.getId();}
    private <T> ResponseEntity<T> ok(T data){return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(data);}
    @GetMapping("/current") public ResponseEntity<?> current(@AuthenticationPrincipal UserDetailsImpl u){return ok(service.current(owner(u)));}
    @PostMapping public ResponseEntity<?> create(@AuthenticationPrincipal UserDetailsImpl u,@RequestBody Create r){return ok(service.create(owner(u),r.name(),r.capacity()));}
    @PostMapping("/join") public ResponseEntity<?> join(@AuthenticationPrincipal UserDetailsImpl u,@RequestBody Join r){return ok(service.join(owner(u),r.invite()));}
    @PostMapping("/{id}/heartbeat") public ResponseEntity<?> heartbeat(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){return ok(service.heartbeat(owner(u),id));}
    @PostMapping("/{id}/timer") public ResponseEntity<?> timer(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id,@RequestBody Timer r){return ok(service.timer(owner(u),id,r.action(),r.minutes(),r.revision()));}
    @PostMapping("/{id}/moderate") public ResponseEntity<?> moderate(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id,@RequestBody Moderate r){return ok(service.moderate(owner(u),id,r.participant(),r.action()));}
    @GetMapping("/{id}/invite") public ResponseEntity<?> invite(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){return ok(Map.of("invite",service.invite(owner(u),id)));}
    @PostMapping("/{id}/voice") public ResponseEntity<?> voice(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){return ok(service.ticket(owner(u),id));}
    @PostMapping("/{id}/voice/leave") public ResponseEntity<?> leaveVoice(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){service.leaveVoice(owner(u),id);return ok(null);}
    @PostMapping("/{id}/leave") public ResponseEntity<?> leave(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){service.leave(owner(u),id);return ok(null);}
}
