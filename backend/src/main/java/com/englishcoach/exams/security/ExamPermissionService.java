package com.englishcoach.exams.security;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import com.englishcoach.auth.policy.AdminIdentityService;
import org.springframework.stereotype.Service;

import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExamPermissionService {

    private final NamedParameterJdbcTemplate jdbcTemplate;
    private final AdminIdentityService adminIdentity;

    public boolean hasOperatorPermission(Long userId, String permissionCode) {
        if (userId == null) return false;

        // The official administrator has every Exams operator privilege. Exams Phase 9A: decided by the CURRENT users row
        // of THIS user id (AdminIdentityService) — no longer by whatever ROLE_ADMIN authority the calling request carries
        // (which ignored the userId being checked).
        if (adminIdentity != null && adminIdentity.isOfficialAdmin(userId)) {
            return true;
        }

        String sql = """
            SELECT COUNT(*) FROM exams.operator_permissions
            WHERE user_id = :userId AND permission_code = :code AND revoked_at IS NULL
        """;
        Integer count = jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("code", permissionCode), Integer.class);

        return count != null && count > 0;
    }

    public void grantPermission(Long targetUserId, String permissionCode, Long grantedBy) {
        String sql = """
            INSERT INTO exams.operator_permissions (id, user_id, permission_code, granted_by, granted_at)
            VALUES (gen_random_uuid(), :targetUserId, :code, :grantedBy, clock_timestamp())
            ON CONFLICT (user_id, permission_code) DO UPDATE SET revoked_at = NULL
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("targetUserId", targetUserId)
                .addValue("code", permissionCode)
                .addValue("grantedBy", grantedBy));
    }

    public void revokePermission(Long targetUserId, String permissionCode) {
        String sql = """
            UPDATE exams.operator_permissions
            SET revoked_at = clock_timestamp()
            WHERE user_id = :targetUserId AND permission_code = :code AND revoked_at IS NULL
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("targetUserId", targetUserId)
                .addValue("code", permissionCode));
    }
}
