package com.englishcoach.premium.voucher;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** The caller's own AI voucher wallet (read only): balance, grants with their expiry and the latest uses. */
@RestController
@RequestMapping("/api/v1/premium/vouchers")
public class AiVoucherController {

    private final AiVoucherService vouchers;

    public AiVoucherController(AiVoucherService vouchers) {
        this.vouchers = vouchers;
    }

    @GetMapping
    public ResponseEntity<AiVoucherService.Wallet> wallet(@AuthenticationPrincipal UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(vouchers.wallet(user.getId()));
    }
}
