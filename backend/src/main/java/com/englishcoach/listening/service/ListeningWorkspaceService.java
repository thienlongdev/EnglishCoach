package com.englishcoach.listening.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import com.englishcoach.auth.policy.AdminIdentityService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Account/lesson/version checkpoints and the Vietnamese pair cache; the server never runs or buys a translation. */
@Service
public class ListeningWorkspaceService {
    public record Segment(long id, Integer start, Integer end, String text) {}
    public record Content(String version, List<Segment> segments) {}
    public record Checkpoint(String contentVersion, long revision, JsonNode state, String savedAt) {}
    public record Save(String contentVersion, long revision, JsonNode state) {}
    public record TranslationSubmit(String contentVersion, String engine, Map<String,String> translations) {}
    public record Translations(String contentVersion, Map<String,String> translations) {}
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final TransactionTemplate tx;
    private final AdminIdentityService admins;
    static final Set<String> FREE_ENGINES = Set.of("chrome-translator", "opus-mt-en-vi");

    public ListeningWorkspaceService(JdbcTemplate jdbc, ObjectMapper mapper, PlatformTransactionManager manager,
                                     AdminIdentityService admins) {
        this.jdbc=jdbc; this.mapper=mapper; this.tx=new TransactionTemplate(manager); this.admins=admins;
    }
    Content content(long user, long lesson) {
        var visible=jdbc.queryForList("SELECT id FROM public.listening_materials WHERE id=? AND (owner_user_id=? OR (is_system=true AND owner_user_id IS NULL))",lesson,user);
        if(visible.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Không tìm thấy bài nghe.");
        var segments=jdbc.query("SELECT id,start_time_ms,end_time_ms,text FROM public.transcript_segments WHERE listening_material_id=? ORDER BY start_time_ms,id",
                (r,n)->new Segment(r.getLong(1),(Integer)r.getObject(2),(Integer)r.getObject(3),r.getString(4)),lesson);
        try {
            byte[] bytes=mapper.writeValueAsBytes(segments);
            return new Content(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),segments);
        } catch(Exception e) {throw new IllegalStateException("Transcript identity unavailable");}
    }
    private JsonNode json(String value) {
        try{return mapper.readTree(value);}catch(Exception e){throw new IllegalStateException("Invalid stored checkpoint");}
    }
    private String encode(JsonNode value) {
        try{return mapper.writeValueAsString(value);}catch(Exception e){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Tiến độ không hợp lệ.");}
    }
    public Checkpoint get(long user,long lesson) {
        Content c=content(user,lesson);
        var rows=jdbc.query("SELECT revision,state::text,updated_at::text FROM public.listening_checkpoints WHERE user_id=? AND material_id=? AND content_version=?",
                (r,n)->new Checkpoint(c.version(),r.getLong(1),json(r.getString(2)),r.getString(3)),user,lesson,c.version());
        if(!rows.isEmpty())return rows.get(0);
        if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM public.listening_checkpoints WHERE user_id=? AND material_id=?)",Boolean.class,user,lesson)))
            return new Checkpoint(c.version(),0,mapper.createObjectNode().set("entries",mapper.createObjectNode()),null);
        // Existing attempt history is read lazily; no rewrite/backfill of learner records.
        ObjectNode state=mapper.createObjectNode();ObjectNode entries=state.putObject("entries");
        jdbc.query("""
                SELECT DISTINCT ON (e.transcript_segment_id) e.transcript_segment_id,a.raw_user_answer,a.is_correct,a.accuracy_percentage,a.primary_error_category,a.id
                FROM public.exercise_attempts a JOIN public.listening_sessions s ON s.id=a.listening_session_id
                JOIN public.listening_exercises e ON e.id=a.listening_exercise_id
                JOIN public.transcript_segments t ON t.id=e.transcript_segment_id AND t.listening_material_id=e.listening_material_id
                WHERE s.user_id=? AND s.listening_material_id=? AND e.listening_material_id=? AND e.expected_answer=t.text
                ORDER BY e.transcript_segment_id,a.id DESC
                """,r->{ObjectNode entry=entries.putObject(r.getString(1));entry.put("draft",Objects.toString(r.getString(2),""));
                    entry.put("status",r.getBoolean(3)?"completed":"evaluated");
                    ObjectNode evaluation=entry.putObject("evaluation");evaluation.put("id",r.getLong(6));evaluation.put("isCorrect",r.getBoolean(3));
                    evaluation.put("accuracyPercentage",r.getDouble(4));evaluation.put("primaryErrorCategory",r.getString(5));
                },user,lesson,lesson);
        return new Checkpoint(c.version(),0,state,null);
    }
    public Checkpoint save(long user,long lesson,Save request) {
        if(request==null||request.revision()<0||request.state()==null||!request.state().isObject())bad();
        Content c=content(user,lesson);if(!c.version().equals(request.contentVersion()))stale();
        JsonNode state=validate(request.state(),c);
        String payload=encode(state);if(payload.getBytes(StandardCharsets.UTF_8).length>1_500_000)bad();
        return tx.execute(status->{
            jdbc.update("INSERT INTO public.listening_checkpoints(user_id,material_id,content_version,state) VALUES(?,?,?, '{}'::jsonb) ON CONFLICT DO NOTHING",user,lesson,c.version());
            var updated=jdbc.query("UPDATE public.listening_checkpoints SET state=?::jsonb,revision=revision+1,updated_at=now() WHERE user_id=? AND material_id=? AND content_version=? AND revision=? RETURNING revision,updated_at::text",
                    (r,n)->new Checkpoint(c.version(),r.getLong(1),state,r.getString(2)),payload,user,lesson,c.version(),request.revision());
            if(updated.isEmpty())throw new ResponseStatusException(HttpStatus.CONFLICT,"Tiến độ đã đổi ở phiên khác. Hãy đồng bộ trước khi lưu.");
            return updated.get(0);
        });
    }
    private JsonNode validate(JsonNode input,Content c) {
        Set<String> ids=new HashSet<>();c.segments().forEach(s->ids.add(Long.toString(s.id())));
        ObjectNode out=mapper.createObjectNode();JsonNode entries=input.path("entries");
        if(!entries.isMissingNode()&&!entries.isObject())bad();
        ObjectNode safe=out.putObject("entries");entries.fields().forEachRemaining(field->{
            if(!ids.contains(field.getKey())||!field.getValue().isObject())bad();
            JsonNode entry=field.getValue();if(entry.path("draft").asText("").length()>10000)bad();
            String status=entry.path("status").asText("draft");if(!Set.of("draft","evaluated","completed","revealed").contains(status))bad();
            ObjectNode clean=safe.putObject(field.getKey());clean.put("draft",entry.path("draft").asText(""));clean.put("status",status);
            JsonNode evaluation=entry.path("evaluation");if(evaluation.isObject()){
                ObjectNode value=clean.putObject("evaluation");value.put("id",evaluation.path("id").asLong());value.put("isCorrect",evaluation.path("isCorrect").asBoolean());
                double accuracy=evaluation.path("accuracyPercentage").asDouble();if(!Double.isFinite(accuracy)||accuracy<0||accuracy>100)bad();
                value.put("accuracyPercentage",accuracy);value.put("primaryErrorCategory",evaluation.path("primaryErrorCategory").asText(""));
            }
        });
        if(input.hasNonNull("selectedSegmentId")){String id=input.get("selectedSegmentId").asText();if(!ids.contains(id))bad();out.put("selectedSegmentId",Long.parseLong(id));}
        double position=input.path("position").asDouble(0);if(!Double.isFinite(position)||position<0||position>604800)bad();out.put("position",position);
        ObjectNode prefs=out.putObject("preferences");JsonNode p=input.path("preferences");
        int repeats=p.path("repeatCount").asInt(5);double gap=p.path("replayGap").asDouble(.5);double speed=p.path("speed").asDouble(1);
        if(repeats<1||repeats>100||!Double.isFinite(gap)||gap<0||gap>10||!Double.isFinite(speed)||speed<.25||speed>2)bad();
        prefs.put("repeatCount",repeats);prefs.put("replayGap",gap);prefs.put("speed",speed);
        return out;
    }
    public Translations translations(long user,long lesson) {
        Content c=content(user,lesson);return new Translations(c.version(),cached(user,lesson,c.version()));
    }
    /**
     * Earlier strong-model pairs (any prompt/model) stay first; then free on-device pairs shared by the official
     * administrator; then the viewer's own. A learner's pairs are never shown to another account.
     */
    private Map<String,String> cached(long user,long lesson,String version) {
        List<String> free=new ArrayList<>();
        for(String engine:FREE_ENGINES){free.add(freeVersion(engine,"u"+user));free.add(freeVersion(engine,"shared"));}
        var rows=jdbc.query("SELECT translator_version,translations::text FROM public.listening_translation_cache WHERE material_id=? AND content_version=? AND (translator_version LIKE 'listening-pairs-1:%' OR translator_version IN (?,?,?,?))",
                (r,n)->Map.entry(r.getString(1),r.getString(2)),lesson,version,free.get(0),free.get(1),free.get(2),free.get(3));
        Map<String,String> result=new LinkedHashMap<>();
        rows.stream().sorted(Comparator.comparingInt(row->rank(row.getKey())))
                .forEach(row->json(row.getValue()).fields().forEachRemaining(f->result.put(f.getKey(),f.getValue().asText())));
        return result;
    }
    private static int rank(String version) {
        if(version.startsWith("listening-pairs-1:"))return 9;
        int engine=version.contains(":chrome-translator:")?1:0;return (version.endsWith(":shared")?4:2)+engine;
    }
    private static String freeVersion(String engine,String scope){return "free-1:"+engine+":"+scope;}
    /** Stores pairs produced on the learner's device: no server inference, no paid provider; existing pairs win. */
    public Translations submit(long user,long lesson,TranslationSubmit request) {
        if(request==null||request.translations()==null||request.translations().isEmpty()||request.translations().size()>64
                ||!FREE_ENGINES.contains(request.engine()))bad();
        Content c=content(user,lesson);if(!c.version().equals(request.contentVersion()))stale();
        Map<String,String> source=new HashMap<>();c.segments().forEach(s->source.put(Long.toString(s.id()),s.text()));
        ObjectNode node=mapper.createObjectNode();
        request.translations().forEach((id,text)->{
            if(!source.containsKey(id))bad();
            String clean=acceptable(text,source.get(id));if(clean!=null)node.put(id,clean);
        });
        if(!node.isEmpty()){
            String scope=admins.isOfficialAdmin(user)?"shared":"u"+user;
            jdbc.update("INSERT INTO public.listening_translation_cache(material_id,content_version,translator_version,translations) VALUES(?,?,?,?::jsonb) ON CONFLICT(material_id,content_version,translator_version) DO UPDATE SET translations=EXCLUDED.translations || listening_translation_cache.translations,updated_at=now()",
                    lesson,c.version(),freeVersion(request.engine(),scope),encode(node));
        }
        return new Translations(c.version(),cached(user,lesson,c.version()));
    }
    /** Lightweight checks only: a failed pair is not stored and stays pending for a later free retry. */
    static String acceptable(String text,String source) {
        if(text==null||source==null)return null;
        String clean=java.text.Normalizer.normalize(text,java.text.Normalizer.Form.NFC).replaceAll("[\\p{Cc}\\p{Cf}]"," ").replaceAll("\\s+"," ").trim();
        String src=source.replaceAll("\\s+"," ").trim();
        if(clean.isEmpty()||clean.indexOf('�')>=0||clean.length()>Math.min(2000,src.length()*4+80))return null;
        if(clean.equalsIgnoreCase(src)&&src.split(" ").length>=3)return null;
        // A generation loop repeats one word; a line that repeats itself ("la, la, la…") may be translated the same way.
        if(longestRun(clean)>=6&&longestRun(src)<3)return null;
        return clean;
    }
    private static int longestRun(String text) {
        String[] words=text.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N} ]","").split(" +");int run=1,best=1;
        for(int i=1;i<words.length;i++){run=words[i].equals(words[i-1])?run+1:1;best=Math.max(best,run);}
        return best;
    }
    private static void bad(){throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"Dữ liệu tiến độ hoặc phân đoạn không hợp lệ.");}
    private static void stale(){throw new ResponseStatusException(HttpStatus.CONFLICT,"Transcript đã thay đổi. Hãy tải lại bài nghe.");}
}
