package com.englishcoach.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class AvatarLookCodeTest {
    @Test void aRealLookPassesThroughUnchanged() {
        String look = "hoodie.joggers.slippers.headphones+glasses.2f3a55.2c3e5e.f2efe6.40303f.3b3f55";
        assertEquals(look, AvatarLookCode.clean(look));
        assertFalse(AvatarLookCode.isV2(look));
        assertEquals("signature.signature.signature.-.2f3a55.2c3e5e.f2efe6.40303f.3b3f55", AvatarLookCode.clean("signature.signature.signature.-.2f3a55.2c3e5e.f2efe6.40303f.3b3f55"));
    }

    @Test void validV2LookCodesPassThroughUnchanged() {
        String lyraV2 = "v2:l:long_wave:cb9578:4a6b8c:808080808080:80808080808080808080808080808080:hoodie.trench_coat.jeans.sneakers.glasses.40303f.2f3a55.2c3e5e.f2efe6.3b3f55";
        assertEquals(lyraV2, AvatarLookCode.clean(lyraV2));
        assertTrue(AvatarLookCode.isV2(lyraV2));

        String kaiMinFace = "v2:k:side_part_02:d4a382:2d3a4b:7f8285807d81:0011223344556677:signature.-.signature.signature.-.3a2a22.2f3a55.2c3e5e.f2efe6.3b3f55";
        assertEquals(kaiMinFace, AvatarLookCode.clean(kaiMinFace));
        assertTrue(AvatarLookCode.isV2(kaiMinFace));

        String maxFace40 = "v2:l:bob_cut:cb9578:4a6b8c:00ff80808080:" + "ab".repeat(20) + ":tee.-.skirt.loafers.cap_glasses.40303f.2f3a55.2c3e5e.f2efe6.3b3f55";
        assertEquals(maxFace40, AvatarLookCode.clean(maxFace40));
        assertTrue(AvatarLookCode.isV2(maxFace40));
    }

    @Test void anythingElseIsDropped() {
        String over256 = "v2:l:long_wave:cb9578:4a6b8c:808080808080:" + "80".repeat(20) + ":" + "a".repeat(180);
        for (String bad : new String[] {
                null, "", "https://evil.example/model.glb", "../../etc/passwd", "<script>",
                "tee.jeans.sneakers.-.zzzzzz.2c3e5e.f2efe6.40303f.3b3f55",
                "tee.jeans.sneakers.-.2f3a55.2c3e5e.f2efe6.40303f",
                "TEE.jeans.sneakers.-.2f3a55.2c3e5e.f2efe6.40303f.3b3f55",
                "a".repeat(200),
                // Invalid V2 shapes
                "v2:x:long_wave:cb9578:4a6b8c:808080808080:8080808080808080:hoodie",
                "v2:l:BAD_UPPER:cb9578:4a6b8c:808080808080:8080808080808080:hoodie",
                "v2:l:" + "a".repeat(25) + ":cb9578:4a6b8c:808080808080:8080808080808080:hoodie",
                "v2:l:bob:CB9578:4a6b8c:808080808080:8080808080808080:hoodie",
                "v2:l:bob:cb9578:4a6b8c:808080:8080808080808080:hoodie",
                "v2:l:bob:cb9578:4a6b8c:808080808080:80808080808080:hoodie",
                "v2:l:bob:cb9578:4a6b8c:808080808080:" + "80".repeat(21) + ":hoodie",
                "v2:l:bob:cb9578:4a6b8c:808080808080:8080808080808080:../../etc",
                "v2:l:bob:cb9578:4a6b8c:808080808080:8080808080808080:hoodie..jeans",
                "v2:l:bob:cb9578:4a6b8c:808080808080:8080808080808080:<script>",
                over256
        }) {
            assertEquals("", AvatarLookCode.clean(bad), "Expected reject for: " + bad);
            assertFalse(AvatarLookCode.isV2(bad));
        }
    }
}
