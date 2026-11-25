package com.englishcoach.studyspace;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.sql.*;
import java.time.*;
import java.util.*;

@Service
public class StudyPlannerService {
    public record Block(UUID id,UUID taskId,String title,Instant start,Instant end,String timeZone,String recurrence,
                        LocalDate until,String project,String notes,int priority,long revision,long focusedSeconds) {}
    public record Occurrence(Block block,Instant start,Instant end) {}
    private final JdbcTemplate jdbc;
    public StudyPlannerService(JdbcTemplate jdbc){this.jdbc=jdbc;}
    private static final String SELECT="""
        SELECT b.*, COALESCE((SELECT sum(f.focused_seconds) FROM public.study_block_sessions l
          JOIN public.study_focus_sessions f ON f.id=l.session_id AND f.user_id=l.user_id
          WHERE l.block_id=b.id AND l.user_id=b.user_id),0) AS focused
        FROM public.study_time_blocks b
        """;
    private Block row(ResultSet r,int n)throws SQLException{
        var until=r.getDate("until_on");
        return new Block(r.getObject("id",UUID.class),r.getObject("task_id",UUID.class),r.getString("title"),r.getTimestamp("start_at").toInstant(),r.getTimestamp("end_at").toInstant(),r.getString("time_zone"),r.getString("recurrence"),until==null?null:until.toLocalDate(),r.getString("project"),r.getString("notes"),r.getInt("priority"),r.getLong("revision"),r.getLong("focused"));
    }
    @Transactional(readOnly=true)
    public List<Block> blocks(long user){return jdbc.query(SELECT+" WHERE b.user_id=? ORDER BY b.start_at",this::row,user);}
    @Transactional(readOnly=true)
    public List<Occurrence> calendar(long user,Instant from,Instant to){
        if(from==null||to==null||!from.isBefore(to)||Duration.between(from,to).toDays()>32)throw fail(400,"INVALID_RANGE");
        var out=new ArrayList<Occurrence>();for(var b:blocks(user))out.addAll(expand(b,from,to));
        out.sort(Comparator.comparing(Occurrence::start));return out;
    }
    public static List<Occurrence> expand(Block b,Instant from,Instant to){
        var out=new ArrayList<Occurrence>();var zone=ZoneId.of(b.timeZone());
        var first=b.start().atZone(zone);var firstEnd=b.end().atZone(zone);
        int step=b.recurrence().equals("DAILY")?1:7;
        for(int day=0;day<=366;day+=step){
            var start=first.plusDays(day);var end=firstEnd.plusDays(day);
            if(day>0&&b.recurrence().equals("NONE"))break;
            if(b.until()!=null&&start.toLocalDate().isAfter(b.until()))break;
            if(!start.toInstant().isBefore(to))break;
            if(end.toInstant().isAfter(from))out.add(new Occurrence(b,start.toInstant(),end.toInstant()));
        }return out;
    }
    private void lock(long user){jdbc.queryForObject("SELECT pg_advisory_xact_lock(111, ?::integer)",Object.class,(int)(user%Integer.MAX_VALUE));}
    @Transactional
    public Block save(long user,UUID id,Block b){
        validate(b);lock(user);
        if(b.taskId()!=null&&jdbc.queryForObject("SELECT count(*) FROM public.study_tasks WHERE id=? AND user_id=?",Integer.class,b.taskId(),user)==0)throw fail(404,"TASK_NOT_FOUND");
        if(id==null){
            if(blocks(user).size()>=500)throw fail(409,"BLOCK_LIMIT");id=UUID.randomUUID();
            jdbc.update("INSERT INTO public.study_time_blocks (id,user_id,task_id,title,start_at,end_at,time_zone,recurrence,until_on,project,notes,priority) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",id,user,b.taskId(),b.title().strip(),Timestamp.from(b.start()),Timestamp.from(b.end()),b.timeZone(),b.recurrence(),b.until(),b.project(),b.notes(),b.priority());
        }else{
            if(jdbc.queryForObject("SELECT count(*) FROM public.study_time_blocks WHERE id=? AND user_id=?",Integer.class,id,user)==0)throw fail(404,"NOT_FOUND");
            int changed=jdbc.update("UPDATE public.study_time_blocks SET task_id=?,title=?,start_at=?,end_at=?,time_zone=?,recurrence=?,until_on=?,project=?,notes=?,priority=?,revision=revision+1,updated_at=now() WHERE id=? AND user_id=? AND revision=?",b.taskId(),b.title().strip(),Timestamp.from(b.start()),Timestamp.from(b.end()),b.timeZone(),b.recurrence(),b.until(),b.project(),b.notes(),b.priority(),id,user,b.revision());
            if(changed==0)throw fail(409,"STALE_REVISION");
        }
        return jdbc.query(SELECT+" WHERE b.id=? AND b.user_id=?",this::row,id,user).getFirst();
    }
    @Transactional public void delete(long user,UUID id){
        lock(user);jdbc.update("DELETE FROM public.study_block_sessions WHERE block_id=? AND user_id=?",id,user);
        if(jdbc.update("DELETE FROM public.study_time_blocks WHERE id=? AND user_id=?",id,user)==0)throw fail(404,"NOT_FOUND");
    }
    @Transactional public void link(long user,UUID block,UUID session){
        lock(user);
        if(jdbc.queryForObject("SELECT count(*) FROM public.study_time_blocks WHERE id=? AND user_id=?",Integer.class,block,user)==0||jdbc.queryForObject("SELECT count(*) FROM public.study_focus_sessions WHERE id=? AND user_id=?",Integer.class,session,user)==0)throw fail(404,"NOT_FOUND");
        jdbc.update("INSERT INTO public.study_block_sessions (session_id,block_id,user_id) VALUES (?,?,?) ON CONFLICT (session_id) DO NOTHING",session,block,user);
        if(jdbc.queryForObject("SELECT count(*) FROM public.study_block_sessions WHERE session_id=? AND block_id=? AND user_id=?",Integer.class,session,block,user)==0)throw fail(409,"SESSION_ALREADY_LINKED");
    }
    static void validate(Block b){
        if(b==null||b.title()==null||b.title().isBlank()||b.title().length()>200||b.start()==null||b.end()==null||!b.start().isBefore(b.end())||Duration.between(b.start(),b.end()).toMinutes()<5||Duration.between(b.start(),b.end()).compareTo(Duration.ofHours(24))>0||b.priority()<0||b.priority()>3||b.recurrence()==null||!Set.of("NONE","DAILY","WEEKLY").contains(b.recurrence())||b.notes()!=null&&b.notes().length()>4000||b.project()!=null&&b.project().length()>60)throw fail(400,"INVALID_BLOCK");
        try{var start=b.start().atZone(ZoneId.of(b.timeZone())).toLocalDate();if(!b.recurrence().equals("NONE")&&(b.until()==null||b.until().isBefore(start)||b.until().isAfter(start.plusDays(365))))throw fail(400,"INVALID_RECURRENCE");}catch(DateTimeException|NullPointerException e){throw fail(400,"INVALID_TIME_ZONE");}
    }
    private static StudySpaceException fail(int status,String code){return new StudySpaceException(status,code);}
}
