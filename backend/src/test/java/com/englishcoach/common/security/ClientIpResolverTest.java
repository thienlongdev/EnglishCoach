package com.englishcoach.common.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

class ClientIpResolverTest {

    private static MockHttpServletRequest from(String peer) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(peer);
        return request;
    }

    @Test
    @DisplayName("Through Nginx: the address Nginx accepted (X-Real-IP) is the client, whatever X-Forwarded-For says")
    void forwardedForIsNeverBelieved() {
        MockHttpServletRequest request = from("172.18.0.4");
        request.addHeader("X-Forwarded-For", "9.9.9.9, 203.0.113.7");
        request.addHeader("X-Real-IP", "203.0.113.7");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("203.0.113.7");
    }

    @Test
    @DisplayName("A rotating spoofed X-Forwarded-For does not change the throttling key")
    void rotatingSpoofKeepsOneKey() {
        String first = null;
        for (int i = 1; i <= 50; i++) {
            MockHttpServletRequest request = from("172.18.0.4");
            request.addHeader("X-Forwarded-For", "10.0.0." + i + ", 198.51.100.23");
            request.addHeader("X-Real-IP", "198.51.100.23");
            String resolved = ClientIpResolver.resolve(request);
            if (first == null) first = resolved;
            assertThat(resolved).isEqualTo(first).isEqualTo("198.51.100.23");
        }
    }

    @Test
    @DisplayName("Two learners behind different addresses keep different keys; one campus address stays one key")
    void distinctClientsStayDistinct() {
        MockHttpServletRequest a = from("172.18.0.4");
        a.addHeader("X-Real-IP", "203.0.113.7");
        MockHttpServletRequest b = from("172.18.0.4");
        b.addHeader("X-Real-IP", "203.0.113.8");

        assertThat(ClientIpResolver.resolve(a)).isNotEqualTo(ClientIpResolver.resolve(b));
    }

    @Test
    @DisplayName("A public peer gets no header trust: the socket address is used")
    void publicPeerHeaderIsIgnored() {
        MockHttpServletRequest request = from("198.51.100.99");
        request.addHeader("X-Real-IP", "1.2.3.4");
        request.addHeader("X-Forwarded-For", "1.2.3.4");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("198.51.100.99");
    }

    @Test
    @DisplayName("X-Real-IP that is not an address literal is ignored (never resolved, never stored)")
    void malformedRealIpFallsBackToPeer() {
        for (String value : new String[]{"", "evil.example.com", "1.2.3.4, 5.6.7.8", "999.1.1.1", "<script>", "a".repeat(200)}) {
            MockHttpServletRequest request = from("172.18.0.4");
            request.addHeader("X-Real-IP", value);
            assertThat(ClientIpResolver.resolve(request)).as(value).isEqualTo("172.18.0.4");
        }
    }

    @Test
    @DisplayName("IPv6 clients and loopback / unique-local peers are handled")
    void ipv6() {
        MockHttpServletRequest request = from("fd00::5");
        request.addHeader("X-Real-IP", "2001:db8::17");
        assertThat(ClientIpResolver.resolve(request)).isEqualTo("2001:db8::17");

        MockHttpServletRequest local = from("::1");
        local.addHeader("X-Real-IP", "2001:db8::18");
        assertThat(ClientIpResolver.resolve(local)).isEqualTo("2001:db8::18");
    }

    @Test
    @DisplayName("No header: the socket peer; no peer at all: loopback")
    void noHeader() {
        assertThat(ClientIpResolver.resolve(from("172.18.0.3"))).isEqualTo("172.18.0.3");
        assertThat(ClientIpResolver.resolve(from(null))).isEqualTo("127.0.0.1");
    }
}
