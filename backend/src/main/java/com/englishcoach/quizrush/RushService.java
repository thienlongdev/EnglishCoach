package com.englishcoach.quizrush;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import java.time.*;
import java.security.SecureRandom;
import static com.englishcoach.quizrush.RushDtos.*;

@Service
public class RushService {
    private final RushQuestions questions;private final RushRepository repo;private final Clock clock;private final RushExposure exposure;private final SecureRandom random=new SecureRandom();
    @org.springframework.beans.factory.annotation.Autowired
    public RushService(RushQuestions questions,RushRepository repo,RushExposure exposure){this(questions,repo,Clock.systemUTC(),exposure);}
    public RushService(RushQuestions questions,RushRepository repo){this(questions,repo,Clock.systemUTC(),null);}
    RushService(RushQuestions questions,RushRepository repo,Clock clock){this(questions,repo,clock,null);}
    RushService(RushQuestions questions,RushRepository repo,Clock clock,RushExposure exposure){this.questions=questions;this.repo=repo;this.clock=clock;this.exposure=exposure==null?repo::recent:exposure;}
    public Config config(){return questions.config();}
    @Transactional(readOnly=true) public Session get(long user,UUID id){return view(repo.get(user,id));}
    @Transactional(readOnly=true) public Session active(long user){var r=repo.active(user);return r==null?null:view(r);}
    @Transactional(readOnly=true) public List<Session> history(long user){return repo.history(user).stream().map(this::view).toList();}
    @Transactional public Session start(long user,Start request){
        repo.lock(user);var existing=repo.byRequest(user,request.requestId());
        if(existing!=null){if(!existing.difficulty.equals(request.difficulty())||!existing.topic.equals(request.topic())||existing.questions.size()!=request.checkpoints())throw new RushException(409,"REQUEST_REUSED");return view(existing);}
        var active=repo.active(user);if(active!=null)throw new RushException(409,"ACTIVE_RACE_EXISTS");
        var race=new RushRepository.Race();race.id=UUID.randomUUID();race.startRequest=request.requestId();race.difficulty=request.difficulty();race.topic=request.topic();race.version=questions.version();race.startedAt=clock.instant().toString();
        race.questions=RushQuestions.escalate(questions.select(request,exposure.recent(user),random.nextLong()));race.courseVersion=RushCompetition.HARDCORE;
        // Hardcore (version 7): the server plans the course (walls and their motion, obstacle zones, orbs); the browser runs it.
        var plan=RushReforged.plan(race.questions,random.nextLong(),request.difficulty(),RushCompetition.HARDCORE);

        race.boundaries=new ArrayList<>(plan.boundaries());race.hazards=new ArrayList<>(plan.hazards());race.walls=new ArrayList<>(plan.walls());race.orbs=new ArrayList<>(plan.orbs());
        race.rising=new ArrayList<>(plan.walls().stream().map(w->w.kind().equals("RISING")).toList());
        race.spacing=race.boundaries.getLast()/race.boundaries.size();repo.save(user,race);return view(race);
    }
    @Transactional public Feedback answer(long user,UUID id,Answer request){
        repo.lock(user);var race=repo.get(user,id);String command=request.questionId()+":"+request.optionId();var previous=race.receipts.get(request.requestId().toString());
        if(previous!=null){if(!previous.command().equals(command))throw new RushException(409,"REQUEST_REUSED");return new Feedback(view(race),previous.correct(),true,previous.explanation());}
        if(!race.status.equals("ACTIVE")||race.checkpoint>=race.questions.size())throw new RushException(409,"RACE_CLOSED");
        if(!questions.available()||!race.version.equals(questions.version()))throw new RushException(409,"CONTENT_CHANGED");
        var q=race.questions.get(race.checkpoint);
        if(!q.id().equals(request.questionId()))throw new RushException(409,"CHECKPOINT_CHANGED");
        if(q.options().stream().noneMatch(o->o.id().equals(request.optionId())))throw new RushException(400,"INVALID_OPTION");
        boolean correct=q.answerId().equals(request.optionId());boolean repeated=!race.tried.add(command);
        String explanation=correct?q.explanation():"Try another gate.";
        if(!repeated){if(correct)race.checkpoint++;else{race.incorrect++;race.mistakes.merge(q.id().toString(),1,Integer::sum);}}
        if(race.receipts.size()>=160)throw new RushException(429,"COMMAND_LIMIT");
        race.receipts.put(request.requestId().toString(),new RushRepository.Receipt(command,correct,explanation));repo.save(user,race);
        return new Feedback(view(race),correct,repeated,explanation);
    }
    @Transactional public Session finish(long user,UUID id){
        repo.lock(user);var race=repo.get(user,id);if(race.status.equals("FINISHED"))return view(race);
        if(!race.status.equals("ACTIVE")||race.checkpoint!=race.questions.size())throw new RushException(409,"RACE_INCOMPLETE");
        race.status="FINISHED";race.finishedAt=clock.instant().toString();repo.save(user,race);return view(race);
    }
    @Transactional public Session abandon(long user,UUID id){repo.lock(user);var race=repo.get(user,id);if(race.status.equals("ACTIVE")){race.status="ABANDONED";repo.save(user,race);}return view(race);}
    private Session view(RushRepository.Race race){
        Question current=null;if(race.status.equals("ACTIVE")&&race.checkpoint<race.questions.size()){
            var q=race.questions.get(race.checkpoint);current=new Question(q.id(),q.family(),q.prompt(),q.context(),q.options());
        }
        var review=new ArrayList<Review>();for(int i=0;i<race.checkpoint;i++){
            var q=race.questions.get(i);review.add(new Review(q.family(),q.prompt(),q.context(),q.answer(),q.explanation(),race.mistakes.getOrDefault(q.id().toString(),0),q.sourceRefs()));
        }
        // Momentum is derived only from the server's own answer record: gates opened on the first try, in order.
        int streak=0,best=0;for(int i=0;i<race.checkpoint;i++){if(race.mistakes.getOrDefault(race.questions.get(i).id().toString(),0)==0)best=Math.max(best,++streak);else streak=0;}
        if(race.checkpoint<race.questions.size()&&race.mistakes.getOrDefault(race.questions.get(race.checkpoint).id().toString(),0)>0)streak=0;
        var walls=race.courseVersion>=RushCompetition.SKYBOUND&&race.boundaries.size()==race.questions.size()?List.copyOf(race.boundaries):List.<Double>of();
        long elapsed=Math.max(0,Duration.between(Instant.parse(race.startedAt),race.finishedAt==null?clock.instant():Instant.parse(race.finishedAt)).toMillis());
        boolean trials=race.courseVersion>=RushCompetition.TRIALS&&!walls.isEmpty(),reforged=trials&&race.courseVersion>=RushCompetition.REFORGED&&race.walls.size()==race.questions.size();
        return new Session(race.id,race.status,race.difficulty,race.topic,race.questions.size(),race.checkpoint,race.checkpoint,race.incorrect,race.startedAt,race.finishedAt,elapsed,current,List.copyOf(review),race.version,race.courseVersion,race.spacing,walls,streak,best,
            trials?List.copyOf(race.hazards):List.of(),trials?List.copyOf(race.rising):List.of(),reforged?List.copyOf(race.walls):List.of(),reforged?List.copyOf(race.orbs):List.of());
    }
}
