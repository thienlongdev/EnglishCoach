package com.englishcoach.quizrush;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.quizrush.RushCompetition.*;

class RushCompetitionTest {
    @ParameterizedTest @ValueSource(ints={3,8,12,20}) void longestNewCourseAllowsEveryCorrectGateAtBaseSpeed(int count){
        var r=race(2);r.questions=Collections.nCopies(count,r.questions.getFirst());r.courseVersion=3;r.spacing=3700;
        while(!r.status.equals("FINISHED")&&r.elapsed<600){
            for(var p:r.racers){p.seenAt=r.elapsed;if(p.phase.equals("RUNNING")){int correct=order(r,p,p.checkpoint).indexOf(0);input(r,p,new Input(p.lastSeq+1,0,center(correct,4),false));}
                if(p.phase.equals("VALIDATING"))answer(r,p,r.questions.get(p.checkpoint).id(),r.questions.get(p.checkpoint).answerId());
                if(p.checkpoint<count&&p.openGate<0)assertTrue(p.y<=barrier(r,p)-RADIUS+.001);}
            advance(r,.01);
        }
        for(var p:r.racers){assertEquals("FINISHED",p.phase);assertEquals(count,p.checkpoint);}assertTrue(r.elapsed<600);
    }
    @Test void swapCannotSkipNewCoursePreviewOrVisibleDecisionWindow(){
        var r=race(2);r.courseVersion=2;r.spacing=2800;skillReady(r);var a=r.racers.get(0);var b=r.racers.get(1);
        assertThrows(RushException.class,()->skill(r,a,b,"POSITION_SWAP"));
        a.phaseTime=b.phaseTime=3;b.y=1150;assertThrows(RushException.class,()->skill(r,a,b,"POSITION_SWAP"));
        b.y=600;skill(r,a,b,"POSITION_SWAP");assertEquals(600,a.y);assertEquals(400,b.y);
    }
    @Test void versionedCoursesKeepLegacySnapshotsAndProvideReadingWindows()throws Exception{
        var json=new com.fasterxml.jackson.databind.ObjectMapper();
        var legacy=json.readValue("{}",Race.class);assertEquals(1,legacy.courseVersion);assertEquals(1100,legacy.spacing);
        var solo=json.readValue("{}",RushRepository.Race.class);assertEquals(1,solo.courseVersion);assertEquals(1100,solo.spacing);
        var r=race(2);var fresh=new Race(r.questions,77);assertEquals(SKYBOUND,fresh.courseVersion);assertEquals(153,BASE_SPEED);assertEquals(.0625,(BASE_SPEED-144)/144,1e-9);
        assertTrue((1600-RADIUS)/330>=4);
        var restored=json.readValue(json.writeValueAsString(fresh),Race.class);assertEquals(fresh.spacing,restored.spacing);assertEquals(fresh.boundaries,restored.boundaries);
        var v3=json.readValue("{\"courseVersion\":3,\"spacing\":2800}",Race.class);assertTrue(v3.boundaries.isEmpty());assertFalse(skybound(v3));
    }
    @Test void sharedQuestionsUseBalancedPrivatePersistedGatePermutations()throws Exception{
        var json=new com.fasterxml.jackson.databind.ObjectMapper();
        for(int gates=2;gates<=4;gates++)for(int racers=2;racers<=5;racers++){
            var options=new ArrayList<RushDtos.Option>();for(int i=0;i<gates;i++)options.add(new RushDtos.Option(UUID.randomUUID(),"option "+i));
            var q=new RushQuestions.Pinned(UUID.randomUUID(),"source","fingerprint","SPELLING_CHOICE","Shared question","",options,options.getFirst().id(),"option 0","explanation","[]");
            var race=new Race(List.of(q),8000+gates*10+racers);for(int i=0;i<racers;i++){var p=new Racer("p"+i,(long)i,"Racer "+i,null);p.ready=true;race.racers.add(p);}start(race);
            var counts=new int[gates];for(var p:race.racers){var permutation=order(race,p,0);assertEquals(gates,new HashSet<>(permutation).size());counts[permutation.indexOf(0)]++;}
            assertTrue(Arrays.stream(counts).max().orElseThrow()-Arrays.stream(counts).min().orElseThrow()<=1,gates+" gates / "+racers+" racers");
            var restored=json.readValue(json.writeValueAsBytes(race),Race.class);for(int i=0;i<racers;i++)assertEquals(order(race,race.racers.get(i),0),order(restored,restored.racers.get(i),0));
        }
    }
    @Test void newCourseFinishesAtWorldAnchoredLine(){var r=race(2);r.courseVersion=3;r.spacing=2800;for(var p:r.racers){p.checkpoint=r.questions.size();p.phase="FINISHING";p.y=r.questions.size()*r.spacing+65;p.phaseTime=0;}double line=finishLine(r);run(r,3);assertTrue(r.racers.stream().allMatch(p->p.phase.equals("FINISHING")&&p.y<line));run(r,2);assertEquals("FINISHED",r.status);for(var p:r.racers)assertEquals(line,p.y,1e-9);}
    @Test void newCourseRecoilStartsAtContactAndNeverTeleports(){
        var r=race(2);r.spacing=2800;r.courseVersion=2;var p=r.racers.getFirst();
        p.y=barrier(r,p)-26;p.phase="VALIDATING";p.selected=order(r,p,0).indexOf(1);
        double contact=p.y;answer(r,p,r.questions.getFirst().id(),r.questions.getFirst().options().get(1).id());assertEquals(contact,p.y);
        double previous=p.y;for(int i=0;i<38;i++){seen(r);advance(r,STEP);assertTrue(p.y<=previous&&previous-p.y<3);assertTrue(p.y<=contact);previous=p.y;}
        run(r,.03);assertEquals(barrier(r,p)-95,p.y,1e-8);assertEquals(0,p.checkpoint);
    }
    static RushQuestions.Pinned question(String prompt,String context,String... labels){
        var options=new ArrayList<RushDtos.Option>();for(String l:labels)options.add(new RushDtos.Option(UUID.randomUUID(),l));
        return new RushQuestions.Pinned(UUID.randomUUID(),"source-"+prompt.hashCode(),"fingerprint","GRAMMAR_TRAP",prompt,context,List.copyOf(options),options.getFirst().id(),labels[0],"explanation","[]");
    }
    static Race skyRace(int n,List<RushQuestions.Pinned> questions){
        var r=new Race(questions,91);for(int i=0;i<n;i++){var p=new Racer("p"+i,(long)i+1,"Explorer",null);p.ready=true;r.racers.add(p);}start(r);advance(r,3.01);return r;
    }
    @Test void skyboundSegmentsBudgetReadingPerCheckpointAndAnchorTheFinish(){
        var shortQ=question("Choose the correctly spelled word.","","lose","lsoe");
        var longQ=question("Choose the verb that agrees with the subject.","The old photographs in the drawer that my grandmother kept for decades still ___ the quiet summers we spent at the lake house together.","remind","reminds","reminding","reminded");
        var r=new Race(List.of(shortQ,longQ,shortQ),5);
        assertEquals(SKYBOUND,r.courseVersion);assertEquals(3,r.boundaries.size());
        double a=r.boundaries.get(0),b=r.boundaries.get(1)-a,c=r.boundaries.get(2)-r.boundaries.get(1);
        assertEquals(1200+80*7,a,1e-9,"seven words: prompt plus two doors");assertEquals(a,c,1e-9);
        assertEquals(1700,segmentLength(question("Pick one.","","a","b")),1e-9,"tiny questions keep a minimum steering/decision segment");
        assertTrue(b>a+1500&&b<=4200,"every word of a long context buys road: "+b);
        // Even an unbroken full-momentum sprint (stamina does not allow one) asks for at most 2.8 words per second.
        for(var q:List.of(shortQ,longQ)){var text=(q.prompt()+" "+q.context()+" "+String.join(" ",q.options().stream().map(RushDtos.Option::label).toList())).trim().split("\\s+").length;
            assertTrue(segmentLength(q)/(V4_SPRINT*momentumLimit())*2.8+.01>=Math.min(text,34),"reading budget "+text);}
        assertEquals(r.boundaries.getLast()+FINISH_OFFSET,finishLine(r),1e-9);assertEquals(a,wall(r,0),1e-9);assertEquals(0,segmentStart(r,0),1e-9);assertEquals(a,segmentStart(r,1),1e-9);
    }
    static double momentumLimit(){return 1+MOMENTUM_STEP*MOMENTUM_CAP;}
    @Test void skyboundMomentumIsEarnedOnlyByFirstTryGatesAndResetsOnMistakes(){
        var q=question("Choose","","right","wrong","other");var r=skyRace(2,List.of(q,q,q,q));var p=r.racers.getFirst();
        assertEquals(1,momentum(r,p),1e-9);run(r,3);assertEquals(V4_BASE,p.speed,1);
        p.phase="VALIDATING";p.selected=order(r,p,0).indexOf(0);assertTrue(answer(r,p,q.id(),q.answerId()));assertEquals(1,p.streak);
        p.streak=p.bestStreak=4;p.phase="RUNNING";p.y=segmentStart(r,1)+10;p.checkpoint=1;run(r,2);assertEquals(V4_BASE*(1+4*MOMENTUM_STEP),p.speed,1);
        UUID wrong=q.options().get(1).id();p.phase="VALIDATING";p.selected=order(r,p,1).indexOf(1);p.y=wall(r,1)-RADIUS;assertFalse(answer(r,p,q.id(),wrong));assertEquals(0,p.streak);assertEquals(4,p.bestStreak);
        run(r,.8);p.phase="VALIDATING";p.selected=order(r,p,1).indexOf(0);assertTrue(answer(r,p,q.id(),q.answerId()));assertEquals(0,p.streak,"a gate opened after a mistake earns no momentum");
        p.streak=40;assertEquals(momentumLimit(),momentum(r,p),1e-9);
        var legacy=race(2);legacy.racers.getFirst().streak=5;assertEquals(1,momentum(legacy,legacy.racers.getFirst()),1e-9);
    }
    @ParameterizedTest @ValueSource(ints={2,5}) void skyboundRaceWithMomentumFinishesBehindEveryClosedWall(int n){
        var questions=new ArrayList<RushQuestions.Pinned>();for(int i=0;i<8;i++)questions.add(question("Question "+i,i%3==0?"A longer context sentence makes this checkpoint deliberately longer to read.":"","right","wrong","other","last"));
        var r=skyRace(n,questions);
        while(!r.status.equals("FINISHED")&&r.elapsed<600){
            for(var p:r.racers){p.seenAt=r.elapsed;var limit=p.checkpoint<8?wall(r,p.checkpoint):finishLine(r);
                if(p.phase.equals("RUNNING")){int correct=order(r,p,p.checkpoint).indexOf(0);input(r,p,new Input(p.lastSeq+1,0,center(correct,4),true));}
                if(p.phase.equals("VALIDATING"))answer(r,p,r.questions.get(p.checkpoint).id(),r.questions.get(p.checkpoint).answerId());
                if(p.checkpoint<8&&p.openGate<0)assertTrue(p.y<=limit-RADIUS+.001);}
            advance(r,.01);
        }
        for(var p:r.racers){assertEquals("FINISHED",p.phase);assertEquals(8,p.checkpoint);assertEquals(8,p.bestStreak);assertEquals(finishLine(r),p.y,1e-9);}
    }
    @Test void escalationOrdersDoorsWithoutChangingTheSelection(){
        var two=question("a","","x","y");var four=question("b","","x","y","z","w");var three=question("c","","x","y","z");var twoB=question("d","","x","y");
        var ordered=RushQuestions.escalate(List.of(four,two,three,twoB));assertEquals(List.of(two,twoB,three,four),ordered);
    }
    static Race race(int n){
        var options=List.of(new RushDtos.Option(UUID.randomUUID(),"right"),new RushDtos.Option(UUID.randomUUID(),"wrong"),new RushDtos.Option(UUID.randomUUID(),"other"),new RushDtos.Option(UUID.randomUUID(),"last"));
        var q=new RushQuestions.Pinned(UUID.randomUUID(),"source","fingerprint","SPELLING_CHOICE","Choose","",options,options.getFirst().id(),"right","explanation","[]");
        var r=new Race(List.of(q,q,q),77);r.courseVersion=1;r.spacing=1100;for(int i=0;i<n;i++){var p=new Racer("p"+i,(long)i+1,"Explorer",null);p.ready=true;r.racers.add(p);}start(r);advance(r,3.01);return r;
    }
    static void seen(Race r){for(var p:r.racers)p.seenAt=r.elapsed;}
    static void run(Race r,double seconds){for(int i=0;i<seconds*100;i++){seen(r);advance(r,.01);}}
    @Test void movementBoundsInputReplayAndLease(){var r=race(2);var p=r.racers.getFirst();input(r,p,new Input(0,-1,null,true));run(r,1);assertTrue(p.x>=76);assertTrue(p.y<185&&p.speed<BASE_SPEED+1,"Sprint expires after input lease");
        assertThrows(RushException.class,()->input(r,p,new Input(0,1,null,false)));assertThrows(RushException.class,()->input(r,p,new Input(-1,0,null,false)));assertThrows(RushException.class,()->input(r,p,new Input(1,Double.NaN,null,false)));assertThrows(RushException.class,()->input(r,p,new Input(1,0,1000.0,false)));assertThrows(RushException.class,()->input(r,p,new Input(150,0,null,false)));}
    @ParameterizedTest @ValueSource(ints={2,3,4,5}) void fullDistinctHumansSealIdenticalTies(int n){var r=race(n);for(var p:r.racers)p.x=500;
        for(int step=0;step<90000&&!r.status.equals("FINISHED");step++){
            for(var p:r.racers){p.seenAt=r.elapsed;if(p.phase.equals("RUNNING")&&p.checkpoint<3){var q=r.questions.get(p.checkpoint);int idx=order(r,p,p.checkpoint).indexOf(0);input(r,p,new Input(p.lastSeq+1,0,center(idx,4),true));}
                if(p.phase.equals("VALIDATING")){var q=r.questions.get(p.checkpoint);answer(r,p,q.id(),q.options().get(order(r,p,p.checkpoint).get(p.selected)).id());}}
            advance(r,.01);
        }assertEquals("FINISHED",r.status);assertEquals(n,r.racers.size());for(var p:r.racers){assertEquals(3,p.checkpoint);assertEquals("FINISHED",p.phase);assertEquals(0,p.mistakes);assertTrue(p.rank>=1);}
        var times=r.racers.stream().map(p->p.finishAt).sorted().toList();assertTrue(times.getFirst()>=3*1100/330.0);double sealed=r.elapsed;advance(r,10);assertEquals(sealed,r.elapsed);}
    @Test void closedGateSweptBoostsPostsAndAnswerValidation(){var r=race(2);var p=r.racers.getFirst();p.y=1065;p.x=center(0,4);p.speed=330;p.dash=.2;run(r,.2);assertEquals("VALIDATING",p.phase);assertEquals(1074,p.y,.01);
        var q=r.questions.getFirst();UUID chosen=q.options().get(order(r,p,0).get(0)).id();assertThrows(RushException.class,()->answer(r,p,UUID.randomUUID(),chosen));assertThrows(RushException.class,()->answer(r,p,q.id(),UUID.randomUUID()));
        boolean correct=answer(r,p,q.id(),chosen);assertEquals(correct?"OPENING":"STUMBLE",p.phase);
        var other=r.racers.get(1);other.x=275;other.y=1070;other.speed=330;run(r,.03);assertEquals("STUMBLE",other.phase);assertEquals(-1,other.selected);assertEquals(0,other.mistakes);}
    @Test void wrongGateUniqueMistakesRecoveryAndOpeningDelay(){var r=race(2);var p=r.racers.getFirst();var q=r.questions.getFirst();int wrong=order(r,p,0).indexOf(1);p.phase="VALIDATING";p.y=1074;p.selected=wrong;assertFalse(answer(r,p,q.id(),q.options().get(1).id()));assertEquals(1,p.mistakes);assertEquals(1074,p.y);run(r,.16);assertTrue(p.y<1074&&p.y>1005);run(r,.55);assertEquals("RUNNING",p.phase);
        p.phase="VALIDATING";p.selected=wrong;answer(r,p,q.id(),q.options().get(1).id());assertEquals(1,p.mistakes);p.phase="VALIDATING";p.selected=order(r,p,0).indexOf(0);p.y=1074;assertTrue(answer(r,p,q.id(),q.answerId()));run(r,.47);assertEquals(1074,p.y,.01);assertEquals(34,p.energy);assertEquals(1,p.charges);run(r,1.4);assertEquals(1,p.checkpoint);}
    static void skillReady(Race r){for(var p:r.racers){p.x=300;p.y=400;p.charges=3;p.phase="RUNNING";p.seenAt=r.elapsed;}r.racers.get(1).x=700;r.racers.get(1).y=600;}
    @Test void iceLocksLateralOnlyExactExpiryImmunityAndReplayResources(){var r=race(2);skillReady(r);var a=r.racers.get(0);var b=r.racers.get(1);skill(r,a,b,"ICE_LOCK");input(r,b,new Input(0,-1,null,true));run(r,.3);assertEquals(700,b.x,.1);assertTrue(b.y>600);assertEquals(2,a.charges);assertThrows(RushException.class,()->skill(r,a,b,"ICE_LOCK"));run(r,.91);assertEquals("",b.effect);assertThrows(RushException.class,()->skill(r,a,b,"TIME_SNARE"));}
    @Test void snareCapsBoostButLeavesSteeringAndHasDistinctDuration(){var r=race(2);skillReady(r);var a=r.racers.get(0);var b=r.racers.get(1);b.speed=330;b.dash=.23;skill(r,a,b,"TIME_SNARE");input(r,b,new Input(0,-1,null,true));run(r,.1);assertTrue(b.x<700);assertTrue(b.speed<=95);run(r,1.71);assertEquals("",b.effect);}
    @Test void swapKeepsQuestionResourcesAndCannotCrossGate(){var r=race(2);skillReady(r);var a=r.racers.get(0);var b=r.racers.get(1);a.energy=75;a.dash=.2;skill(r,a,b,"POSITION_SWAP");assertEquals(600,a.y);assertEquals(700,a.x);assertEquals(400,b.y);assertEquals(75,a.energy);assertEquals(0,a.checkpoint);assertEquals(0,a.dash);assertEquals(2,a.charges);assertThrows(RushException.class,()->skill(r,a,b,"POSITION_SWAP"));}
    @ParameterizedTest @ValueSource(strings={"ICE_LOCK","TIME_SNARE","POSITION_SWAP"}) void skillsRejectAllProtectedStatesAndTargets(String name){var r=race(2);skillReady(r);var a=r.racers.get(0);var b=r.racers.get(1);
        b.y=1000;assertThrows(RushException.class,()->skill(r,a,b,name));b.y=600;b.checkpoint=1;assertThrows(RushException.class,()->skill(r,a,b,name));b.checkpoint=0;b.connected=false;assertThrows(RushException.class,()->skill(r,a,b,name));b.connected=true;b.phase="OPENING";assertThrows(RushException.class,()->skill(r,a,b,name));b.phase="RUNNING";a.charges=0;assertThrows(RushException.class,()->skill(r,a,b,name));assertThrows(RushException.class,()->skill(r,a,a,name));}
    @Test void disconnectStopsProgressThenDnfAndTimeLimitSeals(){var r=race(2);var p=r.racers.getFirst();run(r,.5);double y=p.y;p.connected=false;advance(r,1);assertEquals(y,p.y);advance(r,31);assertEquals("DNF",p.phase);assertEquals("FINISHED",r.status);}
    @Test void seededBotsCompleteUnderSameBarriersAndDifficultyIsReal(){
        for(String level:List.of("EASY","MEDIUM","HARD")){var r=race(2);var p=r.racers.get(1);p.botLevel=level;
            for(int i=0;i<50000&&!p.terminal();i++){r.racers.getFirst().seenAt=r.elapsed;advance(r,.01);assertTrue(p.x>=76&&p.x<=924);if(p.checkpoint<3)assertTrue(p.y<=barrier(r,p)+65.01);}
            assertEquals("FINISHED",p.phase,level+" match="+r.status+" y="+p.y+" checkpoint="+p.checkpoint+" botAt="+p.botAt+" elapsed="+r.elapsed);assertEquals(3,p.checkpoint);assertTrue(p.decisions>3);}
    }
    @Test void sameStepFinishTiesDoNotInventWinner(){var r=race(2);for(var p:r.racers){p.phase="FINISHING";p.phaseTime=1.999;p.checkpoint=3;}run(r,.01);assertEquals("FINISHED",r.status);assertEquals(1,r.racers.get(0).rank);assertEquals(1,r.racers.get(1).rank);}
    @ParameterizedTest @ValueSource(strings={"ICE_LOCK","TIME_SNARE","POSITION_SWAP"}) void cooldownExpiresAtTwelveSecondsAndCannotRunInCountdown(String kind){var r=race(2);skillReady(r);var a=r.racers.get(0);var b=r.racers.get(1);r.status="COUNTDOWN";assertThrows(RushException.class,()->skill(r,a,b,kind));r.status="RUNNING";skill(r,a,b,kind);double until=a.cooldowns.get(kind);assertEquals(12,until-r.elapsed,1e-9);run(r,12.01);skillReady(r);skill(r,a,b,kind);assertEquals(2,a.charges);}
    @Test void botDecisionsAndMotionReproduceFromPersistedSeed()throws Exception{var left=race(3);for(var p:left.racers){p.botLevel="MEDIUM";p.userId=null;}var json=new com.fasterxml.jackson.databind.ObjectMapper();var right=json.readValue(json.writeValueAsString(left),Race.class);for(int i=0;i<3000;i++){advance(left,.02);advance(right,.02);}assertEquals(left.status,right.status);assertEquals(left.elapsed,right.elapsed,1e-9);for(int i=0;i<3;i++){var a=left.racers.get(i);var b=right.racers.get(i);assertEquals(a.phase,b.phase);assertEquals(a.x,b.x,1e-9);assertEquals(a.y,b.y,1e-9);assertEquals(a.checkpoint,b.checkpoint);assertEquals(a.mistakes,b.mistakes);assertEquals(a.charges,b.charges);assertEquals(a.rank,b.rank);assertEquals(a.decisions,b.decisions);}}
}
