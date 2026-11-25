package com.englishcoach.proficiency;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;

/** Reads the migration-seeded anchors of {@code public.proficiency_score_mapping}. */
@Repository
@RequiredArgsConstructor
public class ScoreMappingRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public record Anchor(BigDecimal rawScore, int rating) {}

    /** scale → anchors sorted by raw score. */
    public Map<String, List<Anchor>> loadAll() {
        List<Map<String, Object>> rows = jdbc.getJdbcTemplate().queryForList(
                "SELECT scale, raw_score, rating FROM public.proficiency_score_mapping ORDER BY scale, raw_score");
        return rows.stream().collect(Collectors.groupingBy(
                r -> (String) r.get("scale"),
                TreeMap::new,
                Collectors.mapping(r -> new Anchor((BigDecimal) r.get("raw_score"), ((Number) r.get("rating")).intValue()),
                        Collectors.toList())));
    }
}
