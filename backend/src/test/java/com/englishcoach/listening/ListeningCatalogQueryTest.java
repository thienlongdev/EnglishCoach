package com.englishcoach.listening;

import com.englishcoach.listening.repository.ListeningMaterialRepository;
import org.junit.jupiter.api.Test;
import org.springframework.data.jpa.repository.Query;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import static org.junit.jupiter.api.Assertions.*;

class ListeningCatalogQueryTest {
    @Test void independentCountsPreserveSystemVisibilityAndZeroChildCases() throws Exception {
        try (var db = new PostgreSQLContainer<>("postgres:17")) {
            db.start();
            var jdbc = new JdbcTemplate(new DriverManagerDataSource(db.getJdbcUrl(), db.getUsername(), db.getPassword()));
            jdbc.execute("CREATE TABLE listening_materials(id bigint PRIMARY KEY,title text,channel text,topic text,cefr_level text,accent text,duration_seconds int,thumbnail text,audio_url text,youtube_video_id text,is_system boolean,owner_user_id bigint)");
            jdbc.execute("CREATE TABLE transcript_segments(id bigint PRIMARY KEY,listening_material_id bigint)");
            jdbc.execute("CREATE TABLE listening_exercises(id bigint PRIMARY KEY,listening_material_id bigint)");
            jdbc.execute("INSERT INTO listening_materials(id,title,topic,is_system,owner_user_id) VALUES(1,'zero','A',true,NULL),(2,'segments','A',true,NULL),(3,'exercises','B',true,NULL),(4,'both','B',true,NULL),(5,'private','A',false,10),(6,'quarantined','A',false,NULL),(7,'owned-system','A',true,10)");
            jdbc.execute("INSERT INTO transcript_segments VALUES(1,2),(2,2)");
            jdbc.execute("INSERT INTO listening_exercises VALUES(1,3),(2,3),(3,3)");
            jdbc.execute("INSERT INTO transcript_segments SELECT n+10,4 FROM generate_series(1,100) n");
            jdbc.execute("INSERT INTO listening_exercises SELECT n+10,4 FROM generate_series(1,100) n");
            var query = ListeningMaterialRepository.class.getMethod("findSharedLibraryRows").getAnnotation(Query.class).value();
            var rows = jdbc.queryForList(query);
            assertEquals(4, rows.size());
            long[][] expected = {{1,0,0},{2,2,0},{3,0,3},{4,100,100}};
            for (int i=0; i<4; i++) {
                assertEquals(expected[i][0], ((Number)rows.get(i).get("id")).longValue());
                assertEquals(expected[i][1], ((Number)rows.get(i).get("segmentcount")).longValue());
                assertEquals(expected[i][2], ((Number)rows.get(i).get("exercisecount")).longValue());
            }
            assertEquals("A",rows.get(0).get("topic")); assertEquals("B",rows.get(3).get("topic"));
            String plan = String.join("\n", jdbc.queryForList("EXPLAIN (ANALYZE, FORMAT TEXT) " + query, String.class));
            assertFalse(plan.contains("rows=10000 loops="), "Counting must not form the 100 x 100 child product");
        }
    }
}
