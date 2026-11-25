package com.englishcoach.avatarframe.service;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Automatic grants must write a source allowed by ck_user_avatar_frames_source (V55) for every lineage. */
class AvatarFrameGrantSourceTest {

    private static final Set<String> ALLOWED = Set.of("ACHIEVEMENT", "RANK", "EVENT", "SEASONAL", "PREMIUM", "ADMIN_GRANT", "LEGACY");

    @Test
    @DisplayName("RANKED ⇒ RANK, STANDARD ⇒ ACHIEVEMENT, others unchanged; never a value outside the CHECK")
    void mapping() {
        assertThat(AvatarFrameServiceImpl.grantSource("RANKED")).isEqualTo("RANK");
        assertThat(AvatarFrameServiceImpl.grantSource("STANDARD")).isEqualTo("ACHIEVEMENT");
        assertThat(AvatarFrameServiceImpl.grantSource("ACHIEVEMENT")).isEqualTo("ACHIEVEMENT");
        assertThat(AvatarFrameServiceImpl.grantSource("PREMIUM")).isEqualTo("PREMIUM");
        assertThat(AvatarFrameServiceImpl.grantSource(null)).isEqualTo("ACHIEVEMENT");
        for (String lineage : List.of("ACHIEVEMENT", "RANKED", "STANDARD", "LEGACY", "SEASONAL", "EVENT", "PREMIUM", "SOMETHING_NEW")) {
            assertThat(ALLOWED).contains(AvatarFrameServiceImpl.grantSource(lineage));
        }
    }
}
