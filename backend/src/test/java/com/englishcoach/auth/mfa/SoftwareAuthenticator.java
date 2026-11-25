package com.englishcoach.auth.mfa;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

/**
 * A WebAuthn authenticator written for these tests from the specification (not with the library under test): an
 * ES256 key pair, "none" attestation, hand-encoded CBOR. It produces the JSON a browser's
 * {@code PublicKeyCredential.toJSON()} would, and lets a test lie about any single thing (origin, relying party,
 * challenge, user verification, counter, signature) to prove the verifier notices.
 */
final class SoftwareAuthenticator {

    static final int UP = 0x01, UV = 0x04, BE = 0x08, BS = 0x10, AT = 0x40;

    final byte[] credentialId = new byte[16];
    private final KeyPair keyPair;

    SoftwareAuthenticator() {
        try {
            new SecureRandom().nextBytes(credentialId);
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"));
            keyPair = generator.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    String credentialIdBase64() {
        return b64(credentialId);
    }

    /** The registration response for a challenge, as the page would post it. */
    String register(byte[] challenge, String origin, String rpId, int flags, long counter) {
        byte[] clientData = clientData("webauthn.create", challenge, origin);
        byte[] coseKey = coseKey();
        ByteBuffer authData = ByteBuffer.allocate(37 + 16 + 2 + credentialId.length + coseKey.length);
        authData.put(sha256(rpId.getBytes(StandardCharsets.UTF_8))).put((byte) flags).putInt((int) counter);
        authData.put(new byte[16]).putShort((short) credentialId.length).put(credentialId).put(coseKey);
        byte[] attestationObject = attestationObject(authData.array());
        return "{\"id\":\"" + b64(credentialId) + "\",\"rawId\":\"" + b64(credentialId) + "\",\"type\":\"public-key\","
                + "\"response\":{\"clientDataJSON\":\"" + b64(clientData) + "\",\"attestationObject\":\""
                + b64(attestationObject) + "\",\"transports\":[\"internal\"]},\"clientExtensionResults\":{}}";
    }

    /** The assertion response for a challenge. {@code tamper} flips one bit of the signature. */
    String assertion(byte[] challenge, String origin, String rpId, int flags, long counter, boolean tamper) {
        try {
            byte[] clientData = clientData("webauthn.get", challenge, origin);
            ByteBuffer authData = ByteBuffer.allocate(37);
            authData.put(sha256(rpId.getBytes(StandardCharsets.UTF_8))).put((byte) flags).putInt((int) counter);
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(keyPair.getPrivate());
            signer.update(authData.array());
            signer.update(sha256(clientData));
            byte[] signature = signer.sign();
            if (tamper) signature[signature.length - 1] ^= 0x01;
            return "{\"id\":\"" + b64(credentialId) + "\",\"rawId\":\"" + b64(credentialId) + "\",\"type\":\"public-key\","
                    + "\"response\":{\"clientDataJSON\":\"" + b64(clientData) + "\",\"authenticatorData\":\""
                    + b64(authData.array()) + "\",\"signature\":\"" + b64(signature) + "\"},\"clientExtensionResults\":{}}";
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] clientData(String type, byte[] challenge, String origin) {
        return ("{\"type\":\"" + type + "\",\"challenge\":\"" + b64(challenge) + "\",\"origin\":\"" + origin
                + "\",\"crossOrigin\":false}").getBytes(StandardCharsets.UTF_8);
    }

    /** COSE_Key for ES256 on P-256: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}. */
    private byte[] coseKey() {
        ECPublicKey publicKey = (ECPublicKey) keyPair.getPublic();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0xA5);
        out.write(0x01); out.write(0x02);
        out.write(0x03); out.write(0x26);
        out.write(0x20); out.write(0x01);
        out.write(0x21); out.write(0x58); out.write(0x20); out.writeBytes(fixed32(publicKey.getW().getAffineX()));
        out.write(0x22); out.write(0x58); out.write(0x20); out.writeBytes(fixed32(publicKey.getW().getAffineY()));
        return out.toByteArray();
    }

    /** {"fmt": "none", "attStmt": {}, "authData": bytes} in CBOR. */
    private static byte[] attestationObject(byte[] authData) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0xA3);
        text(out, "fmt"); text(out, "none");
        text(out, "attStmt"); out.write(0xA0);
        text(out, "authData");
        if (authData.length < 256) {
            out.write(0x58); out.write(authData.length);
        } else {
            out.write(0x59); out.write(authData.length >> 8); out.write(authData.length & 0xff);
        }
        out.writeBytes(authData);
        return out.toByteArray();
    }

    private static void text(ByteArrayOutputStream out, String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        out.write(0x60 + bytes.length);
        out.writeBytes(bytes);
    }

    private static byte[] fixed32(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int copy = Math.min(raw.length, 32);
        System.arraycopy(raw, raw.length - copy, out, 32 - copy, copy);
        return out;
    }

    static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String b64(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
