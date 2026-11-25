package com.englishcoach.messenger;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.messenger.MessengerDtos.*;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;

import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Every route answers for the person signed in: no user id ever selects whose conversations these are. */
@Controller
public class MessengerController {
    private static final String BASE = "/api/v1/messenger";
    private final MessengerService service;
    private final MessengerRoomService rooms;

    public MessengerController(MessengerService service, MessengerRoomService rooms) { this.service = service; this.rooms = rooms; }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new MessengerException(401, "AUTH_REQUIRED");
        return user.getId();
    }
    private static <T> ResponseEntity<T> ok(T body) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body); }
    private static ResponseEntity<Void> done() { return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build(); }

    @ExceptionHandler(MessengerException.class) @ResponseBody
    public ResponseEntity<Map<String, String>> refused(MessengerException e) { return ResponseEntity.status(e.status).cacheControl(CacheControl.noStore()).body(Map.of("code", e.code)); }

    @GetMapping(BASE + "/me") @ResponseBody
    public ResponseEntity<Me> me(@AuthenticationPrincipal UserDetailsImpl u) { return ok(service.me(owner(u))); }
    @PutMapping(BASE + "/me") @ResponseBody
    public ResponseEntity<Me> updateMe(@AuthenticationPrincipal UserDetailsImpl u, @RequestBody MeRequest r) { return ok(service.updateMe(owner(u), r)); }
    @GetMapping(BASE + "/people") @ResponseBody
    public ResponseEntity<People> people(@AuthenticationPrincipal UserDetailsImpl u, @RequestParam(defaultValue = "0") int offset) { return ok(service.people(owner(u), offset)); }
    @GetMapping(BASE + "/people/search") @ResponseBody
    public ResponseEntity<PersonPage> search(@AuthenticationPrincipal UserDetailsImpl u, @RequestParam("q") String q, @RequestParam(required = false) String after) { return ok(service.search(owner(u), q, after)); }
    @GetMapping(BASE + "/people/{id}") @ResponseBody
    public ResponseEntity<Profile> profile(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { return ok(service.profile(owner(u), id)); }
    @PostMapping(BASE + "/friends/{id}") @ResponseBody
    public ResponseEntity<Void> addFriend(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.addFriend(owner(u), id); return done(); }
    @DeleteMapping(BASE + "/friends/{id}") @ResponseBody
    public ResponseEntity<Void> removeFriend(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.removeFriend(owner(u), id); return done(); }
    @PostMapping(BASE + "/friends/{id}/decline") @ResponseBody
    public ResponseEntity<Void> declineFriend(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.declineFriend(owner(u), id); return done(); }
    @PostMapping(BASE + "/blocks/{id}") @ResponseBody
    public ResponseEntity<Void> block(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.block(owner(u), id); return done(); }
    @DeleteMapping(BASE + "/blocks/{id}") @ResponseBody
    public ResponseEntity<Void> unblock(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.unblock(owner(u), id); return done(); }

    @PostMapping(BASE + "/restrictions/{id}") @ResponseBody
    public ResponseEntity<Void> restrict(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.restrict(owner(u), id); return done(); }
    @DeleteMapping(BASE + "/restrictions/{id}") @ResponseBody
    public ResponseEntity<Void> unrestrict(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { service.unrestrict(owner(u), id); return done(); }

    @GetMapping(BASE + "/summary") @ResponseBody
    public ResponseEntity<Summary> summary(@AuthenticationPrincipal UserDetailsImpl u) { return ok(service.summary(owner(u))); }
    @GetMapping(BASE + "/conversations") @ResponseBody
    public ResponseEntity<ConversationPage> conversations(@AuthenticationPrincipal UserDetailsImpl u, @RequestParam(required = false) java.time.Instant before, @RequestParam(required = false) String scope) { return ok(service.conversationPage(owner(u), before, scope)); }
    @GetMapping(BASE + "/requests") @ResponseBody
    public ResponseEntity<List<Conversation>> requests(@AuthenticationPrincipal UserDetailsImpl u) { return ok(service.requests(owner(u))); }
    @PostMapping(BASE + "/requests/{id}/accept") @ResponseBody
    public ResponseEntity<Void> acceptRequest(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { service.acceptRequest(owner(u), id); return done(); }
    @PostMapping(BASE + "/requests/{id}/decline") @ResponseBody
    public ResponseEntity<Void> declineRequest(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { service.declineRequest(owner(u), id); return done(); }
    @PostMapping(BASE + "/conversations") @ResponseBody
    public ResponseEntity<Conversation> open(@AuthenticationPrincipal UserDetailsImpl u, @RequestBody OpenRequest r) {
        if (r == null || r.userId() == null) throw new MessengerException(400, "INVALID_REQUEST");
        return ok(service.open(owner(u), r.userId()));
    }
    @GetMapping(BASE + "/conversations/{id}/messages") @ResponseBody
    public ResponseEntity<MessagePage> messages(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestParam(required = false) Long before, @RequestParam(required = false) String q, @RequestParam(required = false) Long downTo) { return ok(rooms.messages(owner(u), id, before, q, downTo)); }
    @PostMapping(BASE + "/conversations/{id}/messages") @ResponseBody
    public ResponseEntity<Message> send(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody SendRequest r) { return ok(rooms.send(owner(u), id, r)); }

    // ── One message: an emoji on it, who put which, taking it back ──
    @PutMapping(BASE + "/messages/{id}/reaction") @ResponseBody
    public ResponseEntity<Void> react(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id, @RequestBody ReactRequest r) {
        if (r == null || r.emoji() == null) throw new MessengerException(400, "INVALID_REQUEST");
        rooms.react(owner(u), id, r.emoji());
        return done();
    }
    @DeleteMapping(BASE + "/messages/{id}/reaction") @ResponseBody
    public ResponseEntity<Void> unreact(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { rooms.react(owner(u), id, null); return done(); }
    @GetMapping(BASE + "/messages/{id}/reactions") @ResponseBody
    public ResponseEntity<List<ReactionPeople>> reactors(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { return ok(rooms.reactors(owner(u), id)); }
    @DeleteMapping(BASE + "/messages/{id}") @ResponseBody
    public ResponseEntity<Void> unsend(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable long id) { rooms.unsend(owner(u), id); return done(); }

    // ── Attachments: private bytes, for the people of the conversation only ──
    @PostMapping(value = BASE + "/conversations/{id}/attachments", consumes = org.springframework.http.MediaType.MULTIPART_FORM_DATA_VALUE) @ResponseBody
    public ResponseEntity<Attachment> upload(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestPart("file") org.springframework.web.multipart.MultipartFile file,
                                             @RequestPart(value = "thumb", required = false) org.springframework.web.multipart.MultipartFile thumb, @RequestParam(value = "name", required = false) String name) {
        return ok(rooms.upload(owner(u), id, file, thumb, name));
    }
    @DeleteMapping(BASE + "/attachments/{id}") @ResponseBody
    public ResponseEntity<Void> discard(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { rooms.discard(owner(u), id); return done(); }
    @GetMapping(BASE + "/conversations/{id}/shared") @ResponseBody
    public ResponseEntity<List<Attachment>> shared(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestParam(defaultValue = "IMAGE") String kind) { return ok(rooms.shared(owner(u), id, kind)); }

    /**
     * Never guessed by the browser (nosniff), never run as a page (sandbox, no scripts), a document always as a download under a name made safe here.
     * Private, so it is cached by the person's own browser only.
     */
    private static ResponseEntity<org.springframework.core.io.Resource> bytes(MessengerRoomService.Download d) {
        org.springframework.http.ContentDisposition disposition = (d.picture() ? org.springframework.http.ContentDisposition.inline() : org.springframework.http.ContentDisposition.attachment())
                .filename(d.name(), java.nio.charset.StandardCharsets.UTF_8).build();
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(java.time.Duration.ofDays(30)).cachePrivate().immutable())
                .header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'; sandbox").header("Content-Disposition", disposition.toString())
                .contentType(org.springframework.http.MediaType.parseMediaType(d.mime())).body(new org.springframework.core.io.FileSystemResource(d.path()));
    }
    @GetMapping(BASE + "/attachments/{id}")
    public ResponseEntity<org.springframework.core.io.Resource> attachment(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return bytes(rooms.download(owner(u), id, false)); }
    @GetMapping(BASE + "/attachments/{id}/thumb")
    public ResponseEntity<org.springframework.core.io.Resource> thumb(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return bytes(rooms.download(owner(u), id, true)); }

    // ── Groups ──
    @PostMapping(BASE + "/groups") @ResponseBody
    public ResponseEntity<Conversation> createGroup(@AuthenticationPrincipal UserDetailsImpl u, @RequestBody GroupRequest r) { return ok(rooms.createGroup(owner(u), r)); }
    @GetMapping(BASE + "/groups/{id}") @ResponseBody
    public ResponseEntity<GroupDetail> group(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return ok(rooms.group(owner(u), id)); }
    @PutMapping(BASE + "/groups/{id}") @ResponseBody
    public ResponseEntity<Conversation> rename(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody GroupUpdate r) { return ok(rooms.rename(owner(u), id, r)); }
    @PutMapping(value = BASE + "/groups/{id}/avatar", consumes = org.springframework.http.MediaType.MULTIPART_FORM_DATA_VALUE) @ResponseBody
    public ResponseEntity<Conversation> groupAvatar(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestPart("file") org.springframework.web.multipart.MultipartFile file) { return ok(rooms.setAvatar(owner(u), id, file)); }
    @GetMapping(BASE + "/groups/{id}/avatar")
    public ResponseEntity<org.springframework.core.io.Resource> groupAvatar(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return bytes(rooms.avatar(owner(u), id)); }
    @PostMapping(BASE + "/groups/{id}/members") @ResponseBody
    public ResponseEntity<GroupDetail> addMembers(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody MembersRequest r) { return ok(rooms.addMembers(owner(u), id, r)); }
    @DeleteMapping(BASE + "/groups/{id}/members/{user}") @ResponseBody
    public ResponseEntity<GroupDetail> removeMember(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @PathVariable long user) { return ok(rooms.remove(owner(u), id, user)); }
    @PutMapping(BASE + "/groups/{id}/members/{user}/role") @ResponseBody
    public ResponseEntity<GroupDetail> role(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @PathVariable long user, @RequestBody RoleRequest r) { return ok(rooms.role(owner(u), id, user, r)); }
    @PostMapping(BASE + "/groups/{id}/leave") @ResponseBody
    public ResponseEntity<Void> leave(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { rooms.leave(owner(u), id); return done(); }
    @PostMapping(BASE + "/conversations/{id}/share") @ResponseBody
    public ResponseEntity<Message> share(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody ShareRequest r) { return ok(service.share(owner(u), id, r)); }
    @PutMapping(BASE + "/conversations/{id}/read") @ResponseBody
    public ResponseEntity<Void> read(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody ReadRequest r) {
        if (r == null || r.messageId() == null) throw new MessengerException(400, "INVALID_REQUEST");
        rooms.read(owner(u), id, r.messageId());
        return done();
    }
    @PutMapping(BASE + "/conversations/{id}/settings") @ResponseBody
    public ResponseEntity<Void> settings(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody SettingsRequest r) { rooms.settings(owner(u), id, r); return done(); }

    @PostMapping(BASE + "/conversations/{id}/arena-invites") @ResponseBody
    public ResponseEntity<Message> invite(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id, @RequestBody InviteRequest r) { return ok(service.invite(owner(u), id, r)); }
    @GetMapping(BASE + "/arena-invites/room/{id}") @ResponseBody
    public ResponseEntity<java.util.List<Invite>> roomInvites(@AuthenticationPrincipal UserDetailsImpl u,@PathVariable UUID id){return ok(service.roomInvites(owner(u),id));}

    @PostMapping(BASE + "/arena-invites/{id}/accept") @ResponseBody
    public ResponseEntity<Invite> accept(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return ok(service.accept(owner(u), id)); }
    @PostMapping(BASE + "/arena-invites/{id}/decline") @ResponseBody
    public ResponseEntity<Invite> decline(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return ok(service.decline(owner(u), id)); }
    @PostMapping(BASE + "/arena-invites/{id}/cancel") @ResponseBody
    public ResponseEntity<Invite> cancel(@AuthenticationPrincipal UserDetailsImpl u, @PathVariable UUID id) { return ok(service.cancel(owner(u), id)); }

    @MessageMapping("/messenger/typing")
    public void typing(@Payload Map<String, String> body, Principal principal) {
        if (!(principal instanceof Authentication a) || !(a.getPrincipal() instanceof UserDetailsImpl user) || user.getId() == null || body == null) return;
        try { rooms.typing(user.getId(), UUID.fromString(String.valueOf(body.get("conversationId")))); } catch (IllegalArgumentException ignored) { /* Not a conversation: nothing to tell anyone. */ }
    }
}
