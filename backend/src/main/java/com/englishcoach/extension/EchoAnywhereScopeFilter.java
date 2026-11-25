package com.englishcoach.extension;

import com.englishcoach.common.security.AuthSessionContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.regex.Pattern;

/**
 * A session of the Echo Anywhere extension is narrow by construction: whatever its token could otherwise do, it reaches
 * only the routes the extension needs (its own endpoints, dictionary lookups, saving / removing a card, the Premium
 * status and the learner's level). Everything else answers 403 {@code EXTENSION_SCOPE} before any controller runs.
 * Runs after the bearer filter, so it sees the session the request was authenticated with.
 */
public class EchoAnywhereScopeFilter extends OncePerRequestFilter {

    private static final Pattern FLASHCARD_ID = Pattern.compile("^/api/v1/flashcards/\\d{1,18}$");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        AuthSessionContext session = AuthSessionContext.current();
        if (session != null && EchoAnywhereConfig.AUTH_METHOD.equals(session.authMethod())
                && !allowed(request.getMethod(), request.getRequestURI())) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setHeader("Cache-Control", "no-store");
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"code\":\"EXTENSION_SCOPE\",\"status\":403,"
                    + "\"message\":\"Echo Anywhere không được phép dùng chức năng này.\"}");
            return;
        }
        chain.doFilter(request, response);
    }

    static boolean allowed(String method, String uri) {
        if (method == null || uri == null) return false;
        String m = method.toUpperCase(java.util.Locale.ROOT);
        if ("OPTIONS".equals(m)) return true;
        if (uri.startsWith("/api/v1/extension/") && !uri.startsWith("/api/v1/extension/pairings")) return true;
        if ("GET".equals(m) && uri.startsWith("/api/v1/dictionary/")) return true;
        if ("GET".equals(m) && (uri.equals("/api/v1/premium/me") || uri.equals("/api/v1/auth/me"))) return true;
        if ("POST".equals(m) && uri.equals("/api/v1/flashcards")) return true;
        return "DELETE".equals(m) && FLASHCARD_ID.matcher(uri).matches();
    }
}
