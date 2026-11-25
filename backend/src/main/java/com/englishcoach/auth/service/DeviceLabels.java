package com.englishcoach.auth.service;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.util.Locale;

/**
 * A coarse description of the device a session is used from ("Chrome · Windows"), for the session list. Only the
 * browser family and the operating system family are kept: never the raw User-Agent, a version or an address, so the
 * label identifies nothing beyond what the user needs to recognise their own device.
 */
public final class DeviceLabels {

    private DeviceLabels() {
    }

    /** The label of the browser making the current request, or null outside a request / without a User-Agent. */
    public static String ofCurrentRequest() {
        if (!(RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes)) return null;
        HttpServletRequest request = attributes.getRequest();
        return of(request.getHeader("User-Agent"));
    }

    public static String of(String userAgent) {
        if (userAgent == null || userAgent.isBlank()) return null;
        String ua = userAgent.toLowerCase(Locale.ROOT);
        String browser;
        if (ua.contains("edg/") || ua.contains("edga/") || ua.contains("edgios/")) browser = "Edge";
        else if (ua.contains("opr/") || ua.contains("opera")) browser = "Opera";
        else if (ua.contains("coc_coc") || ua.contains("coccoc")) browser = "Cốc Cốc";
        else if (ua.contains("samsungbrowser/")) browser = "Samsung Internet";
        else if (ua.contains("firefox/") || ua.contains("fxios/")) browser = "Firefox";
        else if (ua.contains("chrome/") || ua.contains("crios/")) browser = "Chrome";
        else if (ua.contains("safari/")) browser = "Safari";
        else if (ua.contains("node") || ua.contains("curl") || ua.contains("python") || ua.contains("java/")) browser = "Ứng dụng";
        else browser = "Trình duyệt khác";
        String os;
        if (ua.contains("android")) os = "Android";
        else if (ua.contains("iphone") || ua.contains("ipad") || ua.contains("ipod")) os = "iOS";
        else if (ua.contains("windows")) os = "Windows";
        else if (ua.contains("mac os x") || ua.contains("macintosh")) os = "macOS";
        else if (ua.contains("cros")) os = "ChromeOS";
        else if (ua.contains("linux")) os = "Linux";
        else os = null;
        return os == null ? browser : browser + " · " + os;
    }
}
