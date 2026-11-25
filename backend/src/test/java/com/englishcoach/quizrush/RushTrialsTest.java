package com.englishcoach.quizrush;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.quizrush.RushCompetition.*;
import static com.englishcoach.quizrush.RushTrials.*;

/** Course version 5 (Skybound Trials): plan, obstacles, jump / dodge, rising gates, recovery, bots and fairness. */
class RushTrialsTest {
    static List<RushQuestions.Pinned> questions(int n){
        var list=new ArrayList<RushQuestions.Pinned>();
        for(int i=0;i<n;i++)list.add(i%3==0?RushCompetitionTest.question("Choose the correctly spelled word "+i,"","lose","lsoe","loose")
            :RushCompetitionTest.question("Choose the verb that agrees with the subject "+i,"The old photographs in the drawer still ___ the quiet summers we spent together.","remind","reminds","reminding","reminded"));
        return list;
    }
    static Race trialRace(int racers,int gates,String difficulty,long seed,String bot){
        var r=new Race(questions(gates),seed,difficulty);
        for(int i=0;i<racers;i++){var p=new Racer("p"+(i+1),bot==null?(long)i+1:null,"Racer "+i,bot);p.ready=true;r.racers.add(p);}
        start(r);advance(r,3.01);return r;
    }

    @Test void planKeepsTheFirstSegmentClearAndNeverStacksObstacles(){
        for(long seed=1;seed<400;seed++)for(String d:List.of("EASY","MEDIUM","HARD"))for(int n:List.of(3,8,12,20)){
            var plan=plan(questions(n),seed,d);
            assertEquals(n,plan.boundaries().size());assertEquals(n,plan.rising().size());
            assertNull(hazard(plan.hazards(),0),"first segment is clear");assertFalse(plan.rising().getFirst(),"first wall never rises");
            int run=0;for(int i=0;i<n;i++){run=hazard(plan.hazards(),i)!=null?run+1:0;assertTrue(run<=2,"at most two obstacle segments in a row");}
            for(int i=1;i<n;i++)assertFalse(plan.rising().get(i)&&plan.rising().get(i-1),"rising gates never follow each other");
            String previous="";for(var h:plan.hazards()){assertNotEquals(previous,h.kind(),"kinds rotate");previous=h.kind();
                double start=h.checkpoint()==0?0:plan.boundaries().get(h.checkpoint()-1),wall=plan.boundaries().get(h.checkpoint());
                assertEquals(start+LEAD_IN,h.from(),1e-9);assertTrue(h.tier()>=1&&h.tier()<=3);
                // The reading zone after the obstacle is the full reading length: obstacles never spend reading time.
                assertEquals(readingLength(questions(n).get(h.checkpoint())),wall-(h.to()+RUNOUT),1e-6);}
            if(n>=3)assertFalse(plan.hazards().isEmpty(),"every journey meets at least one obstacle");
        }
        assertEquals(plan(questions(12),77,"HARD"),plan(questions(12),77,"HARD"),"deterministic from the seed");
    }

    @Test void readingSecondsAreThoseOfVersionFour(){
        for(var q:questions(6)){double v4=segmentLength(q)/V4_BASE,v5=readingLength(q)/BASE;assertTrue(v5>=v4-.02,"reading time kept: "+v4+" → "+v5);}
        assertEquals(.06,(BASE-V4_BASE)/V4_BASE,1e-9,"running is 6 % faster");
        assertEquals(70.4,apex(),.1);assertEquals(.722,2*JUMP_SPEED/GRAVITY,.001);
    }

    static Hazard hz(String kind,int tier,int lane){return new Hazard(kind,1,10000,10000+length(kind,tier),tier,.3,1,lane,12345);}

    @Test void runeMillIsJumpedAndItsPillarIsSolid(){
        var h=hz("MILL",2,-1);double c=millCenter(h);
        // At some time the beam passes over a point beside the pillar; standing there gets hit, a jumping runner does not.
        double x=500+300,y=c;int hits=0,hitsAir=0;
        for(double t=0;t<6;t+=.005){if(hit(h,t,x,y,0)!=null)hits++;if(hit(h,t,x,y,MILL_TOP+.1)!=null)hitsAir++;}
        assertTrue(hits>0);assertEquals(0,hitsAir);
        // The runner's real jump arc stays above the beam long enough for it to sweep past.
        double above=0;for(double t=0;t<1;t+=.001){double z=JUMP_SPEED*t-.5*GRAVITY*t*t;if(z>=MILL_TOP)above+=.001;}
        assertTrue(above>.4,"time above the beam: "+above);
        assertEquals(500+(MILL_PILLAR+RS)/KX,millPillar(h,500,c),1e-6);assertEquals(800,millPillar(h,800,c),1e-9);
    }

    @Test void boulderRollsAlwaysLeaveAFreeLane(){
        for(int tier=1;tier<=3;tier++){var h=hz("BOULDERS",tier,-1);
            for(double t=0;t<40;t+=.02)for(double y=h.from();y<=h.to();y+=10){int blocked=0;
                for(double lane:LANES)if(hit(h,t,lane,y,0)!=null)blocked++;assertTrue(blocked<3,"one lane free at "+t+","+y);}
            assertFalse(boulders(h,5).isEmpty());}
    }

    @Test void skyfallGapsBetweenLanesAreAlwaysSafeAndEveryImpactIsTelegraphed(){
        for(int tier=1;tier<=3;tier++){var h=hz("SKYFALL",tier,-1);
            for(double t=0;t<30;t+=.01)for(double y=h.from();y<=h.to();y+=5){assertNull(hit(h,t,350,y,0));assertNull(hit(h,t,650,y,0));}
            // A hit is only possible within the landing window of a stone whose warning began a full second earlier.
            for(double t=0;t<30;t+=.01)for(int lane=0;lane<3;lane++){var hit=hit(h,t,LANES[lane],rowY(h,0),0);
                if(hit!=null){double tt=t;int ll=lane;assertTrue(impacts(h,t).stream().anyMatch(i->i.row()==0&&tt>=i.time()-FALL_BEFORE&&tt<=i.time()+FALL_AFTER&&i.safe()!=ll));}}
        }
    }

    @Test void ramsSweepTheRoadButPassOverheadAtTheEndsOfTheirSwing(){
        var h=hz("RAMS",1,-1);double y=ramY(h,1);int clear=0,hits=0;
        for(double t=0;t<8;t+=.01){if(hit(h,t,500,y,0)!=null)hits++;else clear++;}
        assertTrue(hits>0&&clear>hits,"the centre is hit only while a ram swings through");
        assertTrue(ramLift(RAM_SWING)+RAM_LOW>RUNNER_HEIGHT,"at the end of the swing a runner passes beneath the ram");
    }

    @Test void chasmIsJumpedOrCrossedOnTheBeam(){
        var h=hz("CHASM",1,2);double c=chasmCenter(h);
        assertTrue(falls(h,500,c));assertFalse(falls(h,LANES[2],c),"the beam carries a runner");assertFalse(falls(h,500,c-CHASM_HALF[0]));
        for(int tier=1;tier<=3;tier++){var g=hz("CHASM",tier,-1);double edge=chasmCenter(g)-(CHASM_HALF[tier-1]-CHASM_GRACE),far=chasmCenter(g)+(CHASM_HALF[tier-1]-CHASM_GRACE);
            // A base-speed jump taken anywhere in a window of at least a third of a second clears the gap.
            double air=2*JUMP_SPEED/GRAVITY,window=(edge-(far-BASE*air))/BASE;assertTrue(window>=.33,"tier "+tier+" window "+window);}
    }

    @Test void risingGateCanBeEnteredByAJumpAndResetsAfterABounce(){
        var r=trialRace(2,4,"MEDIUM",5,null);var p=r.racers.getFirst();var other=r.racers.get(1);
        r.rising=new ArrayList<>(List.of(false,true,false,false));r.hazards=new ArrayList<>();r.boundaries=new ArrayList<>(List.of(3000.0,9000.0,15000.0,21000.0));
        p.checkpoint=1;p.y=wall(r,1)-RISE_ZONE-5;other.checkpoint=1;other.y=p.y;
        var q=r.questions.get(1);int door=order(r,p,1).indexOf(0);
        // Run straight at the correct door at base speed: the sill is up by arrival, so the racer must jump.
        double arrive=-1;
        for(int i=0;i<1200&&p.phase.equals("RUNNING");i++){input(r,p,new Input(p.lastSeq+1,0,center(door,q.options().size()),false));seenAll(r);
            double gap=barrier(r,p)-RADIUS-p.y,a=gap/Math.max(p.speed,BASE),need=RushTrials.sill(p.riseStart,p.dropStart,p.dropFrom,p.hold,r.elapsed+a)-SILL_STEP;
            if(need>0&&a<=.3&&p.z<=0&&p.vz<=0)input(r,p,new Input(p.lastSeq+1,0,center(door,q.options().size()),false,p.jumpSeq+1,p.dodgeSeq));
            advance(r,STEP);if(arrive<0&&p.riseStart>=0)arrive=r.elapsed;}
        assertEquals("VALIDATING",p.phase,"a timed jump enters the doorway");assertTrue(p.z>0,"standing on the raised sill");assertTrue(p.hold>0);
        assertTrue(answer(r,p,q.id(),q.answerId()));run(r,2);assertEquals(2,p.checkpoint);assertEquals(0,p.z,1e-9,"lands after the gate");
        // The other racer dawdles until the sill is out of reach: bounces, the gate settles, then climbs again.
        other.checkpoint=1;other.riseCheckpoint=1;other.riseStart=.001;other.dropStart=-1;other.hold=-1;other.z=0;other.vz=0;other.selected=-1;other.y=wall(r,1)-RADIUS-1;other.phase="RUNNING";other.speed=BASE;
        input(r,other,new Input(other.lastSeq+1,0,center(order(r,other,1).indexOf(0),q.options().size()),false));advance(r,STEP*2);
        assertEquals("STUMBLE",other.phase);assertEquals(0,other.selected<0?0:1);assertTrue(other.dropStart>=0);
        double later=RushTrials.sill(other.riseStart,other.dropStart,other.dropFrom,other.hold,r.elapsed+DROP_TIME+.01);assertEquals(0,later,1e-9,"the gate settles back to the road");
    }

    @Test void hitsKnockBackThenProtectAndFallsRespawnBeforeTheGap(){
        var r=trialRace(2,6,"MEDIUM",9,null);var p=r.racers.getFirst();
        var mill=new Hazard("MILL",1,6000,6620,1,0,1,-1,7);var chasm=new Hazard("CHASM",2,12000,12520,3,0,1,-1,9);
        r.hazards=new ArrayList<>(List.of(mill,chasm));r.rising=new ArrayList<>(Collections.nCopies(6,false));r.boundaries=new ArrayList<>(List.of(3000.0,9000.0,15000.0,21000.0,27000.0,33000.0));
        p.checkpoint=1;p.y=millCenter(mill);p.x=800;p.phase="RUNNING";
        // Wait for the beam to reach the runner.
        for(int i=0;i<1200&&!p.phase.equals("KNOCKED");i++){seenAll(r);advance(r,STEP);p.y=Math.min(p.y,millCenter(mill));}
        assertEquals("KNOCKED",p.phase);assertEquals(1,p.knocks);assertTrue(p.guard>0);double knockedAt=p.y;
        run(r,KNOCK_TIME+.02);assertEquals("RUNNING",p.phase);assertTrue(p.y<knockedAt+60);
        int knocks=p.knocks;p.y=millCenter(mill);seenAll(r);advance(r,.2);assertEquals(knocks,p.knocks,"protected right after a hit");
        p.checkpoint=2;p.y=chasmCenter(chasm)-1;p.x=500;p.z=0;p.vz=0;p.guard=0;p.phase="RUNNING";seenAll(r);advance(r,STEP*2);
        assertEquals("FALLING",p.phase);assertEquals(1,p.falls);run(r,FALL_TIME+.02);
        assertEquals("RUNNING",p.phase);assertEquals(respawnY(chasm),p.y,BASE*.05);assertTrue(p.guard>0);
    }

    @Test void jumpAndDodgeAreLeaseCountersAppliedOncePerRequest(){
        var r=trialRace(2,3,"EASY",4,null);var p=r.racers.getFirst();p.x=500;
        input(r,p,new Input(0,0,null,false,1,0));advance(r,STEP*2);assertTrue(p.z>0);assertEquals(1,p.jumps);
        input(r,p,new Input(0,0,null,false,1,0));input(r,p,new Input(1,0,null,false,1,0));run(r,1);assertEquals(1,p.jumps,"a repeated counter never jumps again");
        assertThrows(RushException.class,()->input(r,p,new Input(1,0,null,false,2,0)),"a replayed sequence cannot change its request");
        input(r,p,new Input(2,1,null,false,1,1));advance(r,STEP);assertEquals(1,p.dodges);double x=p.x;advance(r,DODGE_TIME);assertTrue(p.x-x>100,"dodge bursts sideways: "+(p.x-x));
        input(r,p,new Input(3,1,null,false,1,2));assertEquals(1,p.dodges,"dodge cools down");
        assertThrows(RushException.class,()->input(r,p,new Input(4,0,null,false,-1,0)));
    }

    @Test void tacticsNeverStackOnAnObstacle(){
        var r=trialRace(2,6,"MEDIUM",3,null);var a=r.racers.get(0);var b=r.racers.get(1);
        var mill=new Hazard("MILL",1,6000,6620,1,0,1,-1,7);r.hazards=new ArrayList<>(List.of(mill));r.boundaries=new ArrayList<>(List.of(3000.0,9000.0,15000.0,21000.0,27000.0,33000.0));
        for(var p:r.racers){p.checkpoint=1;p.charges=3;p.phaseTime=3;}a.y=5100;b.y=5600;
        var e=assertThrows(RushException.class,()->skill(r,a,b,"ICE_LOCK"));assertEquals("HAZARD_PROTECTED",e.getMessage());
        a.y=4400;b.y=4500;skill(r,a,b,"TIME_SNARE");assertEquals("TIME_SNARE",b.effect);
    }

    @ParameterizedTest @ValueSource(strings={"EASY","MEDIUM","HARD"})
    void echoBotsCompleteObstacleCoursesWithoutSoftlocks(String level){
        int knocks=0,falls=0,jumps=0;
        for(long seed=1;seed<=6;seed++){
            var r=new Race(questions(12),seed*31,"HARD");for(int i=0;i<5;i++){var p=new Racer("p"+(i+1),null,"Echo "+i,level);p.ready=true;r.racers.add(p);}start(r);
            for(int s=0;s<120*620&&!r.status.equals("FINISHED");s++){advance(r,STEP);
                for(var p:r.racers){assertTrue(p.x>=76&&p.x<=924);assertTrue(p.z>=0||p.phase.equals("FALLING"));assertTrue(p.y>=-1);}}
            var detail=new StringBuilder(r.reason+" t="+r.elapsed);for(var p:r.racers)detail.append(String.format(" | %s %s cp%d y%.0f/%.0f x%.0f z%.0f k%d f%d m%d",p.id,p.phase,p.checkpoint,p.y,p.checkpoint<r.questions.size()?barrier(r,p):0,p.x,p.z,p.knocks,p.falls,p.mistakes));
            // Every bot either finishes or is closed by the 60-second rule after the winner; none is ever stuck in a loop.
            int finished=0;for(var p:r.racers){if(p.phase.equals("FINISHED"))finished++;else assertEquals("TIME_LIMIT",r.reason,"seed "+seed+detail);
                assertTrue(p.falls<=6,"no fall loop: seed "+seed+detail);knocks+=p.knocks;falls+=p.falls;jumps+=p.jumps;}
            assertTrue(finished>=(level.equals("EASY")?3:4),"seed "+seed+detail);
        }
        assertTrue(jumps>0,"bots jump");
        if(level.equals("EASY"))assertTrue(knocks+falls>0,"easy bots do get caught by obstacles");
        System.out.printf("Trials bots %s: knocks %d, falls %d, jumps %d%n",level,knocks,falls,jumps);
    }

    @Test void legacySnapshotsWithoutPlanKeepTheirRules()throws Exception{
        var json=new com.fasterxml.jackson.databind.ObjectMapper();
        var v4=json.readValue("{\"courseVersion\":4,\"spacing\":2800}",Race.class);assertTrue(v4.hazards.isEmpty());assertFalse(trials(v4));
        var fresh=trialRace(2,8,"MEDIUM",11,null);var restored=json.readValue(json.writeValueAsString(fresh),Race.class);
        assertEquals(fresh.hazards,restored.hazards);assertEquals(fresh.rising,restored.rising);assertEquals(TRIALS,restored.courseVersion);
        var solo=json.readValue("{}",RushRepository.Race.class);assertTrue(solo.hazards.isEmpty());
    }


    /**
     * A careful human stand-in for persistence / capacity tests: reads the course plan from the racer's own view, jumps
     * the mill / chasm / rising sill and steers around the rest. Returns {targetX, jump (1/0)}.
     */
    @SuppressWarnings("unchecked")
    static double[] pilot(Map<String,Object> view,double door){
        var players=(List<Map<String,Object>>)view.get("players");String you=(String)view.get("you");
        var own=players.stream().filter(p->p.get("id").equals(you)).findFirst().orElseThrow();var personal=(Map<String,Object>)view.get("personal");
        double x=((Number)own.get("x")).doubleValue(),y=((Number)own.get("y")).doubleValue(),z=((Number)own.get("z")).doubleValue(),t=((Number)view.get("elapsed")).doubleValue();
        int cp=((Number)own.get("checkpoint")).intValue();var hazards=(List<Hazard>)view.getOrDefault("hazards",List.of());var h=hazard(hazards,cp);
        if(!"RUNNING".equals(own.get("phase"))||z>0)return new double[]{door,0};
        if(h!=null&&y>h.from()-700&&y<h.to()+60){
            if(h.kind().equals("MILL")||h.kind().equals("CHASM")){double tau=threat(h,t,x,x,y,BASE,.45);return new double[]{Math.abs(x-500)<80?620:x,(h.kind().equals("CHASM")?tau<=.15:tau>=.12&&tau<=.3)?1:0};}
            double best=x,score=-1;for(double c:new double[]{x,200,350,500,650,800}){double v=Math.min(threat(h,t,x,c,y,BASE,1.2),1.3)*1000-Math.abs(c-x)*.2;if(v>score){score=v;best=c;}}
            return new double[]{best,0};
        }
        List<Double> walls=(List<Double>)view.get("boundaries");List<Boolean> rising=(List<Boolean>)view.getOrDefault("rising",List.of());
        if(rising(rising,cp)&&cp<walls.size()){double arrive=(walls.get(cp)-26-y)/BASE;
            double need=sill(((Number)personal.get("riseStart")).doubleValue(),((Number)personal.get("dropStart")).doubleValue(),((Number)personal.get("dropFrom")).doubleValue(),((Number)personal.get("hold")).doubleValue(),t+arrive)-SILL_STEP;
            double height=JUMP_SPEED*arrive-.5*GRAVITY*arrive*arrive;if(need>0&&arrive<=.36&&height>=need)return new double[]{door,1};}
        return new double[]{door,0};
    }
    static void seenAll(Race r){for(var p:r.racers)p.seenAt=r.elapsed;}
    static void run(Race r,double seconds){for(double t=0;t<seconds;t+=STEP){seenAll(r);advance(r,STEP);}}
}
