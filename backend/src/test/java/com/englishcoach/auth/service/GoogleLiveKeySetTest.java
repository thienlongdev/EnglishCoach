package com.englishcoach.auth.service;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

import java.security.KeyPairGenerator;
import java.util.Date;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Opt-in (needs the network): the production decoder really reads Google's published key set, and a well-formed
 * RS256 token signed by any other key is refused BECAUSE no Google key matches, not because the keys were unreachable.
 * Run with {@code -Dgoogle.live=true}.
 */
@EnabledIfSystemProperty(named = "google.live", matches = "true")
class GoogleLiveKeySetTest {

    @Test
    @DisplayName("Production decoder: Google's key set is reachable and a foreign RS256 signature matches none of its keys")
    void foreignSignatureMatchesNoGoogleKey() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        SignedJWT forged = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID("not-a-google-key").build(),
                new JWTClaimsSet.Builder().issuer("https://accounts.google.com").subject("1")
                        .audience("x.apps.googleusercontent.com").issueTime(new Date())
                        .expirationTime(new Date(System.currentTimeMillis() + 60000)).build());
        forged.sign(new RSASSASigner(generator.generateKeyPair().getPrivate()));

        JwtDecoder decoder = GoogleIdTokenVerifier.googleSignatureDecoder();
        assertThatThrownBy(() -> decoder.decode(forged.serialize()))
                .isInstanceOf(JwtException.class)
                .satisfies(e -> assertThat(e.getMessage()).doesNotContainIgnoringCase("retrieve")
                        .doesNotContainIgnoringCase("timed out").doesNotContainIgnoringCase("I/O error"));
    }
}
