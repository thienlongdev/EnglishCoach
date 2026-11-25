package com.englishcoach.echolife;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echolife.EchoLifeDtos.SaveWorldRequest;
import com.englishcoach.echolife.EchoLifeDtos.World;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * Echo Life — the signed-in learner's world save ({@code anyRequest().authenticated()}; CSRF as every cookie-authenticated
 * write). Scoped to the principal: there is no user-id parameter and no way to name another learner's world. No AI.
 */
@RestController
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(name="app.echo-life.enabled",havingValue="true",matchIfMissing=true)
@Validated
@RequestMapping("/api/v1/echo-life")
public class EchoLifeController {

    private final EchoLifeService worlds;
    private final EchoLifeBulkhead bulkhead;

    public EchoLifeController(EchoLifeService worlds) {
        this(worlds, EchoLifeBulkhead.unbounded());
    }

    @org.springframework.beans.factory.annotation.Autowired
    public EchoLifeController(EchoLifeService worlds, org.springframework.beans.factory.ObjectProvider<EchoLifeBulkhead> bulkhead) {
        this(worlds, bulkhead.getIfAvailable(EchoLifeBulkhead::unbounded));
    }

    private EchoLifeController(EchoLifeService worlds, EchoLifeBulkhead bulkhead) {
        this.worlds = worlds;
        this.bulkhead = bulkhead;
    }

    @GetMapping("/world")
    public ResponseEntity<World> get(@AuthenticationPrincipal UserDetailsImpl user) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> worlds.get(uid)));
    }

    @PutMapping("/world")
    public ResponseEntity<World> save(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody SaveWorldRequest request) {
        long uid = owner(user);
        return ok(bulkhead.execute(() -> worlds.save(uid, request)));
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new EchoLifeException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
