package com.englishcoach.common.security;

/**
 * What a log line may say about an account's address: enough to follow one account through a log (first character
 * and domain), never the address itself. The full address lives in the audit table, behind the database's access rules.
 */
public final class LogMask {

    private LogMask() {
    }

    public static String email(String address) {
        if (address == null || address.isBlank()) {
            return "(none)";
        }
        String value = address.trim();
        int at = value.lastIndexOf('@');
        if (at <= 0 || at == value.length() - 1) {
            return "***";
        }
        return value.charAt(0) + "***" + value.substring(at);
    }
}
