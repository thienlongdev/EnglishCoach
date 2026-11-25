package com.englishcoach.learningpath;

import com.englishcoach.grammar.*;
import com.englishcoach.learningpath.OdysseyDtos.*;
import com.englishcoach.learningpath.LearningPathDtos.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.*;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/** The Odyssey is a view over existing learning evidence, never a competing academic authority. */
@Service
public class OdysseyService {
    private final OdysseyRepository repo;
    private final OdysseyCatalog catalog;
    private final LearningPathService path;
    private final LearningPathRepository plans;
    private final GrammarContent content;
    private final GrammarRepository grammar;
    private final GrammarService academy;
    private static final Pattern TOPIC=Pattern.compile("[a-z0-9][a-z0-9-]{0,79}");
    private static final Pattern EXAM=Pattern.compile("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/(TOEIC_PART_[1-7]|IELTS_LISTENING_SECTION_[1-4]|IELTS_READING_PASSAGE_[1-3])");
    public OdysseyService(OdysseyRepository repo,OdysseyCatalog catalog,LearningPathService path,LearningPathRepository plans,
                          GrammarContent content,GrammarRepository grammar,GrammarService academy) {
        this.repo=repo;this.catalog=catalog;this.path=path;this.plans=plans;this.content=content;this.grammar=grammar;this.academy=academy;
    }
    @Transactional
    public World world(long user) {
        repo.lock(user);
        TodayView today=path.today(user);
        List<Reward> added=repo.reconcile(user);
        List<Station> topics=grammarStations(user);
        List<Station> tasks=today.tasks().stream().map(t->taskStation(t,today.plan()==null?"GENERAL":today.plan().goal())).toList();
        List<RegionView> regions=OdysseyCatalog.REGIONS.stream().map(r->{
            List<Station> in=topics.stream().filter(t->t.regionId().equals(r.id()) || r.id().equals("review")&&t.status().equals("REVIEW_DUE")).toList();
            return new RegionView(r,in.size()+(int)tasks.stream().filter(t->t.regionId().equals(r.id())).count(),
                (int)in.stream().filter(t->t.status().equals("CHECK_PASSED")).count(),(int)in.stream().filter(t->t.status().equals("REVIEW_DUE")).count());
        }).toList();
        List<Station> recommended=new ArrayList<>(tasks);
        topics.stream().filter(t->t.status().equals("REVIEW_DUE")).limit(2).forEach(recommended::add);
        recommended.addAll(recommendGrammar(topics,today.plan()));
        return new World(OdysseyCatalog.VERSION,content.revision(),regions,repo.exploration(user),repo.navigation(user),repo.journal(user,0),
            repo.rewards(user),added,today,path.summary(user),recommended,repo.skillEvidence(user),repo.latestLaunch(user));
    }
    @Transactional(readOnly=true)
    public RegionDetail region(long user,String id) {
        var r=catalog.region(id);
        List<Station> out=new ArrayList<>();
        List<Station> topics=grammarStations(user);
        topics.stream().filter(s->s.regionId().equals(id)||id.equals("review")&&s.status().equals("REVIEW_DUE")).forEach(out::add);
        String goal=plans.plan(user).map(LearningPathRepository.Plan::goal).orElse("GENERAL");
        // Read-only: region browsing never generates a day or mutates completion.
        plans.tasksOn(user,LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh"))).stream().filter(t->Set.of("OPEN","DONE").contains(t.status()))
            .map(t->repo.task(user,t.id()).orElseThrow()).map(t->taskStation(t,goal)).filter(s->s.regionId().equals(id)).forEach(out::add);
        out.add(workflow(id));
        return new RegionDetail(OdysseyCatalog.VERSION,r,out);
    }
    @Transactional
    public List<Exploration> discover(long user,ExploreRequest request) {
        catalog.region(request.regionId());repo.lock(user);repo.discover(user,request.regionId(),request.activateBeacon());return repo.exploration(user);
    }
    @Transactional
    public Navigation navigate(long user,NavigateRequest request) {
        catalog.region(request.regionId());
        if(request.stationId()!=null) {
            Station s=station(user,request.stationId());
            if(!s.regionId().equals(request.regionId())&&!request.regionId().equals("review"))throw new LearningPathException(400,"INVALID_LOCATION");
        }
        repo.lock(user);repo.navigate(user,request);return repo.navigation(user);
    }
    @Transactional
    public Navigation preferences(long user,PreferencesRequest request) {
        LocalDate now=LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh"));
        if(request.targetDate()!=null&&(request.targetDate().isBefore(now)||request.targetDate().isAfter(now.plusYears(10))))throw new LearningPathException(400,"INVALID_DATE");
        repo.lock(user);repo.preferences(user,request);return repo.navigation(user);
    }
    @Transactional
    public LaunchView launch(long user,LaunchRequest request) {
        repo.lock(user);
        Optional<Launch> previous=repo.launch(user,request.requestId());
        if(previous.isPresent()) {
            Launch l=previous.get();
            if(!l.stationId().equals(request.stationId())||!l.mode().equals(request.mode()))throw new LearningPathException(409,"REQUEST_CONFLICT");
            return new LaunchView(l,href(user,l));
        }
        if(repo.launchesToday(user)>=160)throw new LearningPathException(429,"RATE_LIMITED");
        Station s=station(user,request.stationId());
        Long task=s.task()==null?null:s.task().id();String topic=s.kind().equals("GRAMMAR")?s.id().substring(8):null;UUID check=null;
        if(topic==null&&!request.mode().equals("LEARN"))throw new LearningPathException(400,"INVALID_MODE");
        if(topic!=null) {
            if(request.mode().equals("ADVANCE")&&!Set.of("READY","NOT_REQUIRED").contains(s.gate().state()))throw new LearningPathException(409,"COMPETENCY_REQUIRED");
            if(Set.of("CHECK","REVIEW").contains(request.mode())) {
                if(!s.checkAvailable())throw new LearningPathException(409,"ASSESSMENT_UNAVAILABLE");
                try { check=academy.startCheck(user,new GrammarDtos.CheckRequest(request.mode().equals("REVIEW")?"REVIEW":"TOPIC",topic)).id(); }
                catch(GrammarException e) { throw new LearningPathException(e.status(),e.code()); }
            }
        }
        Launch l=new Launch(request.requestId(),s.id(),s.regionId(),request.mode(),task,topic,check,Instant.now());
        String destination=href(user,l); // validate before persisting any route
        repo.insertLaunch(user,l);repo.discover(user,s.regionId(),true);
        repo.navigate(user,new NavigateRequest(s.regionId(),s.id(),"REGION"));
        return new LaunchView(l,destination);
    }
    @Transactional(readOnly=true)
    public List<Reward> journal(long user,int offset) { if(offset<0||offset>1000000)throw new LearningPathException(400,"INVALID_OFFSET");return repo.journal(user,offset); }
    @Transactional(readOnly=true)
    public LaunchView active(long user) { Launch l=repo.latestLaunch(user);return l==null?null:new LaunchView(l,href(user,l)); }
    @Transactional(readOnly=true)
    public LaunchView launchById(long user,UUID id) { Launch l=repo.launch(user,id).orElseThrow(()->new LearningPathException(404,"NOT_FOUND"));return new LaunchView(l,href(user,l)); }

    private List<Station> grammarStations(long user) {
        Map<String,GrammarRepository.State> states=grammar.states(user).stream().collect(Collectors.toMap(GrammarRepository.State::slug,s->s));
        Map<String,OdysseyRepository.TopicCheck> checks=repo.latestTopicChecks(user);
        Map<String,OdysseyCatalog.Words> titles=new HashMap<>();
        for(var domain:content.catalog().path("domains"))for(var t:domain.path("topics"))
            titles.put(t.path("slug").asText(),new OdysseyCatalog.Words(t.path("title").path("vi").asText(),t.path("title").path("en").asText()));
        Instant now=Instant.now();
        return content.topics().stream().filter(GrammarContent.TopicMeta::available).sorted(Comparator.comparingInt(GrammarContent.TopicMeta::path).thenComparing(GrammarContent.TopicMeta::slug)).map(t->{
            GrammarRepository.State state=states.get(t.slug());
            boolean current=current(t,states.get(t.slug()),checks.get(t.slug()),now);
            List<String> required=t.prerequisites().stream().filter(p->content.meta(p).isPresent()).toList();
            List<String> missing=required.stream().filter(p->!current(content.meta(p).orElseThrow(),states.get(p),checks.get(p),now)).toList();
            boolean review=state!=null&&state.masteredAt()!=null&&(state.needsReview()||state.reviewDueAt()!=null&&!state.reviewDueAt().isAfter(now));
            String status=current?"CHECK_PASSED":review?"REVIEW_DUE":checks.containsKey(t.slug())?"REMEDIATION":state!=null&&state.practiceScored()>0?"PRACTISING":state!=null&&state.studiedAt()!=null?"STUDIED":"NOT_STARTED";
            // A direct challenge check can establish the target concept without forcing an advanced learner through all preparatory lessons.
            Gate gate=new Gate(current||missing.isEmpty()?"READY":"PREREQUISITES",required,current?List.of():missing,"ACADEMY_TOPIC_CHECK","PRACTICE_OR_CHALLENGE");
            return new Station("grammar:"+t.slug(),catalog.grammarRegion(t.slug()),titles.get(t.slug()),"GRAMMAR","GRAMMAR",t.level(),t.domain(),status,gate,t.checkItems()>=4,t.learningRole(),required,null,state==null?null:state.lastCheckAt());
        }).toList();
    }
    static boolean current(GrammarContent.TopicMeta t,GrammarRepository.State s,OdysseyRepository.TopicCheck c,Instant now) {
        return s!=null&&s.masteredAt()!=null&&!s.needsReview()&&s.reviewDueAt()!=null&&s.reviewDueAt().isAfter(now)
            &&c!=null&&c.passed()&&c.contentVersion()==t.version();
    }
    /** A supported starting level changes the actual route. Unknown Grammar history is not evidence of beginner ability.
        A known level stands in for the topics BELOW it (no beginner detour), never for a missing prerequisite at the
        learner's own level or above: such a topic waits until that prerequisite is current (no jump past a same-level step). */
    static List<Station> recommendGrammar(List<Station> topics,PlanView plan) {
        boolean provisional=plan==null||"PROVISIONAL".equals(plan.levelBasis());
        int level=levelIndex(provisional?"A1":plan.level());
        Map<String,String> levels=new HashMap<>();
        for(Station t:topics)if(t.id().startsWith("grammar:"))levels.put(t.id().substring(8),t.level());
        return topics.stream().filter(t->!Set.of("CHECK_PASSED","REVIEW_DUE").contains(t.status())&&!"reference".equals(t.learningRole()))
            .filter(t->provisional?levelIndex(t.level())<=level&&t.gate().missing().isEmpty()
                :levelIndex(t.level())==level&&t.gate().missing().stream().noneMatch(m->levelIndex(levels.getOrDefault(m,"C2"))>=level))
            .sorted(Comparator.comparingInt(t->Set.of("STUDIED","PRACTISING","REMEDIATION").contains(t.status())?0:1))
            .limit(2).toList();
    }
    private Station station(long user,String id) {
        if(id.startsWith("grammar:")&&TOPIC.matcher(id.substring(8)).matches())return grammarStations(user).stream().filter(s->s.id().equals(id)).findFirst().orElseThrow(()->new LearningPathException(404,"NOT_FOUND"));
        if(id.matches("task:[1-9][0-9]{0,17}")) {
            TaskView t=repo.task(user,Long.parseLong(id.substring(5))).filter(v->Set.of("OPEN","DONE").contains(v.status())).orElseThrow(()->new LearningPathException(404,"NOT_FOUND"));
            return taskStation(t,plans.plan(user).map(LearningPathRepository.Plan::goal).orElse("GENERAL"));
        }
        if(id.startsWith("workflow:"))return workflow(catalog.region(id.substring(9)).id());
        throw new LearningPathException(404,"NOT_FOUND");
    }
    private Station taskStation(TaskView t,String goal) {
        return new Station("task:"+t.id(),catalog.taskRegion(t.kind(),t.targetKey()==null?goal:t.targetKey()),new OdysseyCatalog.Words(t.title(),t.title()),t.kind(),t.skill(),null,null,t.status(),
            new Gate("NOT_REQUIRED",List.of(),List.of(),"TASK_COMPLETION_NOT_MASTERY",null),false,"daily",List.of(),t,null);
    }
    private Station workflow(String region) {
        OdysseyCatalog.Region r=catalog.region(region);
        return new Station("workflow:"+region,region,new OdysseyCatalog.Words("Mở không gian học","Open learning space"),"WORKFLOW",r.skill(),null,null,"AVAILABLE",
            new Gate("NOT_REQUIRED",List.of(),List.of(),"NO_COMPLETION_CREDIT",null),false,"optional",List.of(),null,null);
    }
    private String href(long user,Launch l) {
        if(l.checkId()!=null)return "/grammar/check/"+l.checkId();
        if(l.topicSlug()!=null)return "/grammar/topics/"+l.topicSlug()+(l.mode().equals("ADVANCE")?"?layer=deep":"");
        if(l.taskId()!=null)return taskHref(repo.task(user,l.taskId()).orElseThrow(()->new LearningPathException(404,"NOT_FOUND")));
        return switch(l.regionId()) {
            case "memory"->"/flashcards?review=due";case "reef"->"/listening";case "archive"->"/reading";
            case "voices","communication"->"/speaking?mode=topic";case "lagoon"->"/writing?view=coach";
            case "trade"->"/exams/toeic";case "summit"->"/exams/ielts";case "trial"->"/exams";
            case "review"->"/grammar/practice?kind=due";default->"/grammar/library";
        };
    }
    static String taskHref(TaskView t) {
        return switch(t.kind()) {
            case "PLACEMENT"->"/learning-path?view=odyssey&placement=1";
            case "VOCAB_REVIEW"->"/flashcards?review=due";
            case "DICTATION"->t.targetId()!=null&&t.targetId()>0?"/listening/"+t.targetId()+"/practice":invalid();
            case "READING"->t.targetId()!=null&&t.targetId()>0?"/reading?materialId="+t.targetId():invalid();
            case "TOPIC_SPEAKING"->"/speaking?mode=topic";
            case "WRITING"->{var w=LearningPathEngine.WRITING_TASKS.get(t.targetKey());yield w==null?invalid():"/writing?view=coach&taskId="+w.taskId()+"&start=draft";}
            case "EXAM_PRACTICE"->{String ref=t.targetRef();String family=t.targetKey();
                if(ref==null||family==null||!Set.of("IELTS","TOEIC").contains(family)||!EXAM.matcher(ref).matches()||!ref.split("/")[1].startsWith(family+"_"))yield invalid();
                String[] parts=ref.split("/");yield "/exams/"+family.toLowerCase(Locale.ROOT)+"/tests/"+parts[0]+"?part="+parts[1]+"#practice";}
            default->invalid();
        };
    }
    private static String invalid() { throw new LearningPathException(409,"ACTIVITY_UNAVAILABLE"); }
    private static int levelIndex(String level) { return List.of("preA1","A1","A2","B1","B2","C1","C2").indexOf(level); }
}
