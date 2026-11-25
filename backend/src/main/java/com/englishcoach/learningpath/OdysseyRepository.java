package com.englishcoach.learningpath;

import com.englishcoach.learningpath.OdysseyDtos.*;
import org.springframework.jdbc.core.namedparam.*;
import org.springframework.stereotype.Repository;
import java.sql.*;
import java.time.*;
import java.util.*;

/** Owner-scoped presentation state. This repository cannot write any academic evidence table. */
@Repository
public class OdysseyRepository {
    private final NamedParameterJdbcTemplate jdbc;
    public OdysseyRepository(NamedParameterJdbcTemplate jdbc) { this.jdbc=jdbc; }
    private MapSqlParameterSource p(long user) { return new MapSqlParameterSource("u",user); }
    private static Instant at(ResultSet r,String name) throws SQLException { Timestamp t=r.getTimestamp(name);return t==null?null:t.toInstant(); }
    public void lock(long user) { jdbc.query("SELECT pg_advisory_xact_lock(2029603,:k)",p(user).addValue("k",(int)(user^(user>>>32))),rs->null); }
    public Navigation navigation(long user) {
        return jdbc.query("SELECT * FROM public.odyssey_navigation WHERE user_id=:u",p(user),(r,n)->new Navigation(
            r.getString("region_id"),r.getString("station_id"),r.getString("view_mode"),r.getObject("target_date",LocalDate.class),
            (Integer)r.getObject("weekly_minutes"),r.getString("exam_variant"),r.getLong("revision"))).stream().findFirst()
            .orElse(new Navigation("harbor",null,"ATLAS",null,null,null,0));
    }
    public void navigate(long user,NavigateRequest request) {
        jdbc.update("""
            INSERT INTO public.odyssey_navigation(user_id,region_id,station_id,view_mode) VALUES(:u,:r,:s,:v)
            ON CONFLICT(user_id) DO UPDATE SET region_id=EXCLUDED.region_id,station_id=EXCLUDED.station_id,
            view_mode=EXCLUDED.view_mode,revision=public.odyssey_navigation.revision+1,updated_at=now()
            """,p(user).addValue("r",request.regionId()).addValue("s",request.stationId()).addValue("v",request.viewMode()));
    }
    public void preferences(long user,PreferencesRequest req) {
        jdbc.update("""
            INSERT INTO public.odyssey_navigation(user_id,target_date,weekly_minutes,exam_variant) VALUES(:u,:d,:m,:v)
            ON CONFLICT(user_id) DO UPDATE SET target_date=EXCLUDED.target_date,weekly_minutes=EXCLUDED.weekly_minutes,
            exam_variant=EXCLUDED.exam_variant,revision=public.odyssey_navigation.revision+1,updated_at=now()
            """,p(user).addValue("d",req.targetDate()).addValue("m",req.weeklyMinutes()).addValue("v",req.examVariant()));
    }
    public List<Exploration> exploration(long user) {
        return jdbc.query("SELECT * FROM public.odyssey_exploration WHERE user_id=:u ORDER BY discovered_at,region_id",p(user),
            (r,n)->new Exploration(r.getString("region_id"),at(r,"discovered_at"),at(r,"beacon_at")));
    }
    public void discover(long user,String region,boolean beacon) {
        jdbc.update("""
            INSERT INTO public.odyssey_exploration(user_id,region_id,beacon_at) VALUES(:u,:r,CASE WHEN :b THEN now() ELSE NULL END)
            ON CONFLICT(user_id,region_id) DO UPDATE SET beacon_at=COALESCE(public.odyssey_exploration.beacon_at,EXCLUDED.beacon_at)
            """,p(user).addValue("r",region).addValue("b",beacon));
    }
    private Launch launchRow(ResultSet r,int n) throws SQLException {
        return new Launch(r.getObject("request_id",UUID.class),r.getString("station_id"),r.getString("region_id"),r.getString("mode"),
            (Long)r.getObject("task_id"),r.getString("topic_slug"),r.getObject("check_id",UUID.class),at(r,"created_at"));
    }
    public Optional<Launch> launch(long user,UUID id) {
        return jdbc.query("SELECT * FROM public.odyssey_launch WHERE user_id=:u AND request_id=:id",p(user).addValue("id",id),this::launchRow).stream().findFirst();
    }
    public Launch latestLaunch(long user) {
        return jdbc.query("SELECT * FROM public.odyssey_launch WHERE user_id=:u ORDER BY created_at DESC,request_id DESC LIMIT 1",p(user),this::launchRow).stream().findFirst().orElse(null);
    }
    public int launchesToday(long user) { return Objects.requireNonNull(jdbc.queryForObject(
        "SELECT count(*) FROM public.odyssey_launch WHERE user_id=:u AND created_at>now()-interval '1 day'",p(user),Integer.class)); }
    public void insertLaunch(long user,Launch l) {
        jdbc.update("""
            INSERT INTO public.odyssey_launch(user_id,request_id,station_id,region_id,mode,task_id,topic_slug,check_id)
            VALUES(:u,:id,:s,:r,:m,:t,:g,:c)
            """,p(user).addValue("id",l.requestId()).addValue("s",l.stationId()).addValue("r",l.regionId()).addValue("m",l.mode())
                .addValue("t",l.taskId()).addValue("g",l.topicSlug()).addValue("c",l.checkId()));
    }
    public Optional<LearningPathDtos.TaskView> task(long user,long id) {
        return jdbc.query("SELECT * FROM public.learning_path_task WHERE user_id=:u AND id=:id",p(user).addValue("id",id),(r,n)->new LearningPathDtos.TaskView(
            r.getLong("id"),r.getString("kind"),r.getString("skill"),(Long)r.getObject("target_id"),r.getString("target_key"),r.getString("title"),
            r.getInt("minutes"),r.getInt("goal_count"),r.getInt("progress_count"),r.getString("status"),r.getString("reason_code"),
            r.getObject("carried_from")!=null,(Integer)r.getObject("result_pct"),r.getString("target_ref"))).stream().findFirst();
    }
    /** Rewards are cosmetic receipts, not a second completion/proficiency store. The SQL owns source validation. */
    public List<Reward> reconcile(long user) {
        return jdbc.query("""
            WITH candidates AS (
              SELECT DISTINCT 'TASK'::varchar AS kind,t.id::varchar AS ref,l.region_id
              FROM public.odyssey_launch l JOIN public.learning_path_task t ON t.id=l.task_id AND t.user_id=l.user_id
              WHERE l.user_id=:u AND t.status='DONE' AND t.completed_at IS NOT NULL AND t.evidence_ref IS NOT NULL
              UNION
              SELECT DISTINCT 'GRAMMAR_CHECK'::varchar,l.topic_slug,l.region_id
              FROM public.odyssey_launch l JOIN public.grammar_check_session c ON c.user_id=l.user_id
                AND (c.id=l.check_id OR (l.check_id IS NULL AND c.scope=l.topic_slug AND c.started_at>=l.created_at))
              WHERE l.user_id=:u AND c.submitted_at IS NOT NULL AND c.scope=l.topic_slug
                AND c.kind IN ('TOPIC','REVIEW') AND c.result->>'enoughEvidence'='true'
                AND c.result->>'mastery' IN ('MASTERED','KEPT')
            ) INSERT INTO public.odyssey_reward(user_id,source_kind,source_ref,region_id)
              SELECT :u,kind,ref,min(region_id) FROM candidates GROUP BY kind,ref
              ON CONFLICT(user_id,source_kind,source_ref) DO NOTHING RETURNING *
            """,p(user),this::rewardRow);
    }
    private Reward rewardRow(ResultSet r,int n) throws SQLException {
        return new Reward(r.getString("source_kind"),r.getString("source_ref"),r.getString("region_id"),at(r,"granted_at"));
    }
    public List<Reward> journal(long user,int offset) { return jdbc.query(
        "SELECT * FROM public.odyssey_reward WHERE user_id=:u ORDER BY granted_at DESC,source_kind,source_ref LIMIT 40 OFFSET :o",
        p(user).addValue("o",offset),this::rewardRow); }
    public int rewards(long user) { return Objects.requireNonNull(jdbc.queryForObject(
        "SELECT count(*) FROM public.odyssey_reward WHERE user_id=:u",p(user),Integer.class)); }
    public List<SkillEvidence> skillEvidence(long user) { return jdbc.query("""
        SELECT skill,status,rating FROM public.skill_proficiency WHERE user_id=:u AND skill IN ('LISTENING','READING','SPEAKING','WRITING')
        """,p(user),(r,n)->new SkillEvidence(r.getString("skill"),r.getString("status"),
            "UNDETERMINED".equals(r.getString("status"))?null:LearningPathEngine.cefrOfRating(r.getInt("rating")),"VERIFIED".equals(r.getString("status")))); }
    public record TopicCheck(String slug,boolean passed,Instant submittedAt,int contentVersion) {}
    public Map<String,TopicCheck> latestTopicChecks(long user) {
        List<TopicCheck> rows=jdbc.query("""
            SELECT DISTINCT ON (scope) scope,submitted_at,
              (result->>'enoughEvidence'='true' AND result->>'mastery' IN ('MASTERED','KEPT')) AS passed,
              COALESCE((exercise_ids->'items'->0->>'version')::integer,0) AS version
            FROM public.grammar_check_session WHERE user_id=:u AND submitted_at IS NOT NULL AND kind IN ('TOPIC','REVIEW')
            ORDER BY scope,submitted_at DESC,id DESC
            """,p(user),(r,n)->new TopicCheck(r.getString("scope"),r.getBoolean("passed"),at(r,"submitted_at"),r.getInt("version")));
        Map<String,TopicCheck> out=new HashMap<>();rows.forEach(v->out.put(v.slug(),v));return out;
    }
}
