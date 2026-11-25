package com.englishcoach.common.security;

import jakarta.servlet.http.HttpServletRequest;

import java.net.InetAddress;
import java.util.regex.Pattern;

/**
 * The client address used for throttling and audit. Only two things are believed:
 * the socket peer, and {@code X-Real-IP} when the peer is one of our own containers.
 *
 * The backend port is not published: every request comes from Nginx, which overwrites {@code X-Real-IP} with the
 * address it accepted the connection from, or from the frontend container, which copies the value Nginx gave it.
 * {@code X-Forwarded-For} is never read: Nginx appends to whatever the browser sent, so its first entry is the
 * caller's own text. A public peer (the port exposed by mistake) gets no header trust at all.
 */
public final class ClientIpResolver {

    private static final Pattern IPV4 = Pattern.compile(
            "^(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}$");
    private static final Pattern HEX_GROUP = Pattern.compile("^[0-9a-fA-F]{1,4}$");

    private ClientIpResolver() {
    }

    public static String resolve(HttpServletRequest request) {
        String peer = request.getRemoteAddr();
        if (peer == null || peer.isBlank()) {
            peer = "127.0.0.1";
        }
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && isInternalPeer(peer)) {
            String candidate = realIp.trim();
            if (isIpLiteral(candidate)) {
                return candidate;
            }
        }
        return peer;
    }

    /** Strict IPv4/IPv6 syntax check only: an untrusted string is never handed to DNS. */
    static boolean isIpLiteral(String value) {
        if (value == null || value.isEmpty() || value.length() > 45) return false;
        if (IPV4.matcher(value).matches()) return true;
        return isStrictIpv6Literal(value);
    }

    private static boolean isStrictIpv6Literal(String value) {
        if (value.length() < 2 || value.indexOf(':') < 0) return false;
        if (value.contains(":::")) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex && c != ':' && c != '.') return false;
        }
        if ((value.startsWith(":") && !value.startsWith("::"))
                || (value.endsWith(":") && !value.endsWith("::"))) {
            return false;
        }
        int doubleColon = value.indexOf("::");
        if (doubleColon >= 0) {
            if (value.indexOf("::", doubleColon + 2) >= 0) return false;
            String left = value.substring(0, doubleColon);
            String right = value.substring(doubleColon + 2);
            int leftGroups = countIpv6Groups(left, false);
            if (leftGroups < 0) return false;
            int rightGroups = countIpv6Groups(right, true);
            if (rightGroups < 0) return false;
            return leftGroups + rightGroups < 8;
        }
        return countIpv6Groups(value, true) == 8;
    }

    private static int countIpv6Groups(String segment, boolean allowTrailingIpv4) {
        if (segment.isEmpty()) return 0;
        String[] parts = segment.split(":", -1);
        int count = 0;
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty()) return -1;
            if (part.indexOf('.') >= 0) {
                if (!allowTrailingIpv4 || i != parts.length - 1 || !IPV4.matcher(part).matches()) {
                    return -1;
                }
                count += 2;
            } else if (HEX_GROUP.matcher(part).matches()) {
                count += 1;
            } else {
                return -1;
            }
        }
        return count;
    }

    static boolean isInternalPeer(String peer) {
        if (!isIpLiteral(peer)) return false;
        try {
            InetAddress address = InetAddress.getByName(peer);
            if (address.isLoopbackAddress() || address.isSiteLocalAddress() || address.isLinkLocalAddress()) {
                return true;
            }
            byte[] raw = address.getAddress();
            return raw.length == 16 && (raw[0] & 0xfe) == 0xfc; // IPv6 unique local, fc00::/7
        } catch (Exception e) {
            return false;
        }
    }
}
