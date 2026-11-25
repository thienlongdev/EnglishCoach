package com.englishcoach.hangman;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import java.sql.*;
import java.util.*;
import static com.englishcoach.hangman.HangmanRules.*;

@Repository
public class HangmanRepository {
    public record Progress(long userId,Difficulty difficulty,int highest,int last,boolean completed,UUID current) {}
    public record StoredRound(UUID id,long userId,int level,String category,String answerVersion,State state) {}
    private final JdbcTemplate jdbc; public HangmanRepository(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public Progress progress(long user,Difficulty d){var rows=jdbc.query("SELECT * FROM public.hangman_progress WHERE user_id=? AND difficulty=?",this::progressRow,user,d.name());return rows.isEmpty()?new Progress(user,d,1,1,false,null):rows.getFirst();}
    public Progress lockTrack(long user,Difficulty d){jdbc.update("INSERT INTO public.hangman_progress(user_id,difficulty) VALUES(?,?) ON CONFLICT DO NOTHING",user,d.name());return jdbc.query("SELECT * FROM public.hangman_progress WHERE user_id=? AND difficulty=? FOR UPDATE",this::progressRow,user,d.name()).getFirst();}
    public StoredRound owned(long user,UUID id){var rows=jdbc.query("SELECT * FROM public.hangman_rounds WHERE user_id=? AND id=?",this::roundRow,user,id);if(rows.isEmpty())throw new HangmanException(404,"ROUND_NOT_FOUND");return rows.getFirst();}
    /** Lifetime encounter history, collapsed to unique answers across every owner track.
     * Result size is bounded by the finite vocabulary; called only at creation. */
    public List<HangmanWordSelection.Encounter> encounters(long user){return jdbc.query("SELECT answer,MAX(created_at) AS last_seen FROM public.hangman_rounds WHERE user_id=? GROUP BY answer ORDER BY last_seen DESC,answer",(rs,n)->new HangmanWordSelection.Encounter(rs.getString(1),rs.getTimestamp(2).toInstant()),user);}
    public StoredRound insert(long user,HangmanCatalog.Level level,State state){UUID id=UUID.randomUUID();jdbc.update("INSERT INTO public.hangman_rounds(id,user_id,difficulty,level_number,answer,answer_version,category,prefilled_letters,remaining_balloons,status) VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE')",id,user,level.difficulty().name(),level.levelNumber(),state.answer(),level.answerVersion(),level.category(),state.prefilled(),state.remaining());jdbc.update("UPDATE public.hangman_progress SET current_round_id=?,last_played_level=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND difficulty=?",id,level.levelNumber(),user,level.difficulty().name());return new StoredRound(id,user,level.levelNumber(),level.category(),level.answerVersion(),state);}
    public StoredRound save(StoredRound round,State next){int changed=jdbc.update("UPDATE public.hangman_rounds SET guessed_letters=?,hinted_letters=?,remaining_balloons=?,status=?,version=?,completed_at=CASE WHEN ?='ACTIVE' THEN NULL ELSE CURRENT_TIMESTAMP END WHERE user_id=? AND id=? AND version=?",next.guessed(),next.hinted(),next.remaining(),next.status().name(),next.version(),next.status().name(),round.userId(),round.id(),round.state().version());if(changed!=1)throw new HangmanException(409,"ROUND_CHANGED");return new StoredRound(round.id(),round.userId(),round.level(),round.category(),round.answerVersion(),next);}
    public void unlock(StoredRound round,int count){int next=Math.min(round.level()+1,count);boolean completed=round.level()==count;jdbc.update("UPDATE public.hangman_progress SET highest_unlocked=GREATEST(highest_unlocked,?),catalog_completed=catalog_completed OR ?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND difficulty=?",next,completed,round.userId(),round.state().difficulty().name());}
    public UUID replay(long user,UUID request,String key){var rows=jdbc.query("SELECT command_key,result_round_id FROM public.hangman_command_receipts WHERE user_id=? AND request_id=?",(rs,n)->Map.entry(rs.getString(1),rs.getObject(2,UUID.class)),user,request);if(rows.isEmpty())return null;var r=rows.getFirst();if(!r.getKey().equals(key))throw new HangmanException(409,"REQUEST_ID_REUSED");return r.getValue();}
    public void receipt(long user,UUID request,String key,UUID result){Integer count=jdbc.queryForObject("SELECT count(*) FROM public.hangman_command_receipts WHERE result_round_id=? AND user_id=?",Integer.class,result,user);if(count!=null&&count>=64)throw new HangmanException(429,"COMMAND_LIMIT");jdbc.update("INSERT INTO public.hangman_command_receipts(user_id,request_id,command_key,result_round_id) VALUES(?,?,?,?)",user,request,key,result);}
    private Progress progressRow(ResultSet rs,int row)throws SQLException{return new Progress(rs.getLong("user_id"),Difficulty.valueOf(rs.getString("difficulty")),rs.getInt("highest_unlocked"),rs.getInt("last_played_level"),rs.getBoolean("catalog_completed"),rs.getObject("current_round_id",UUID.class));}
    private StoredRound roundRow(ResultSet rs,int row)throws SQLException{State state=new State(rs.getString("answer"),Difficulty.valueOf(rs.getString("difficulty")),rs.getString("prefilled_letters"),rs.getString("guessed_letters"),rs.getString("hinted_letters"),rs.getInt("remaining_balloons"),Status.valueOf(rs.getString("status")),rs.getInt("version"));return new StoredRound(rs.getObject("id",UUID.class),rs.getLong("user_id"),rs.getInt("level_number"),rs.getString("category"),rs.getString("answer_version"),state);}
}
