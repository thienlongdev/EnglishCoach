package com.englishcoach.quizrush;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.quizrush.RushCompetition.*;
import static com.englishcoach.quizrush.RushReforged.*;
import static com.englishcoach.quizrush.RushTrials.Hazard;

/** Course version 6 (Reforged): manual movement, open edges, moving walls, new obstacles, orbs, bots and fairness. */
class RushReforgedTest {
    static List<RushQuestions.Pinned> questions(int n){return RushTrialsTest.questions(n);}
    static Race race(int racers,int gates,String difficulty,long seed,String bot){
        var r=new Race(questions(gates),seed,difficulty,REFORGED);
        for(int i=0;i<racers;i++){var p=new Racer("p"+(i+1),bot==null?(long)i+1:null,"Racer "+i,bot);p.ready=true;r.racers.add(p);}
        start(r);advance(r,3.01);return r;
    }
    /** A bare course with one segment of our choosing (hazards and wall motion set by the test). */
    static Race lab(List<Hazard> hazards,Wall wall){
        var r=race(2,2,"MEDIUM",5,null);r.hazards=new ArrayList<>(hazards);
        r.walls=new ArrayList<>(List.of(wall==null?still():wall,still()));r.rising=new ArrayList<>(List.of(wall!=null&&wall.kind().equals("RISING"),false));
        r.boundaries=new ArrayList<>(List.of(6000.0,12000.0));r.orbs=new ArrayList<>();
        for(var p:r.racers){p.y=0;p.x=500;p.floorY=-80;p.vx=p.vy=0;p.phase="RUNNING";p.lastSlide=0;}
        return r;
    }
    static Wall still(){return new Wall("STATIC",1,0,0,0,0,0,0,0,0,0,0);}
    static void hold(Race r,Racer p,double h,double f,double seconds){for(double t=0;t<seconds;t+=STEP){p.horizontal=h;p.forward=f;p.inputAt=r.elapsed;p.seenAt=r.elapsed;for(var o:r.racers)o.seenAt=r.elapsed;advance(r,STEP);}}

    @Test void planShapesEverySegmentFairly(){
        for(long seed=1;seed<300;seed++)for(String d:List.of("EASY","MEDIUM","HARD"))for(int n:List.of(3,8,12,20)){
            var qs=questions(n);var plan=plan(qs,seed,d);
            assertEquals(n,plan.boundaries().size());assertEquals(n,plan.walls().size());
            assertTrue(hazards(plan.hazards(),0).isEmpty(),"first segment is clear");assertEquals("STATIC",plan.walls().getFirst().kind(),"first wall stands still");
            int run=0;for(int i=0;i<n;i++){run=hazards(plan.hazards(),i).isEmpty()?0:run+1;assertTrue(run<=3,"at most three obstacle segments in a row");}
            for(int i=1;i<n;i++)assertFalse(plan.walls().get(i).kind().equals("RISING")&&plan.walls().get(i-1).kind().equals("RISING"));
            for(int i=0;i<n;i++){
                double start=i==0?0:plan.boundaries().get(i-1),wall=plan.boundaries().get(i),reading=readingLength(qs.get(i));var w=plan.walls().get(i);
                var mine=hazards(plan.hazards(),i);assertTrue(mine.size()<=2);
                if(!mine.isEmpty()){assertEquals(start+LEAD_IN,mine.getFirst().from(),1e-9);assertEquals(reading,wall-(mine.getLast().to()+RUNOUT),1e-6,"reading approach after the obstacles");}
                for(var h:mine){assertTrue(h.tier()>=1&&h.tier()<=(d.equals("EASY")?3:4),"tier "+h.tier());assertTrue(KINDS.contains(h.kind()));}
                // A moving wall never reaches back into the run-out: there is always room to stand and read.
                assertTrue(w.travel()<=reading-WALL_ROOM+1e-9);if(w.travel()>0)assertTrue(w.advance()>0&&w.retreat()>0&&w.rest()>0);
                assertTrue(w.amp()<=900.0/qs.get(i).options().size()*.3+1e-9,"slide stays within a door bay");
            }
            for(var o:plan.orbs()){double start=o.checkpoint()==0?0:plan.boundaries().get(o.checkpoint()-1);assertTrue(o.y()>start&&o.y()<plan.boundaries().get(o.checkpoint())-200,"orb inside its segment, before the wall");
                assertTrue(o.x()>=200&&o.x()<=800);assertTrue(List.of("SPEED","ENERGY","GUARD").contains(o.kind()));}
            int guard=-9;for(var o:plan.orbs())if(o.kind().equals("GUARD")){assertTrue(o.checkpoint()-guard>=3,"guard orbs are rare");guard=o.checkpoint();}
            if(n>=3)assertFalse(plan.hazards().isEmpty());
        }
        assertEquals(plan(questions(12),77,"HARD"),plan(questions(12),77,"HARD"),"deterministic from the seed");
        // Late segments are harder than early ones.
        double early=0,late=0;int ne=0,nl=0;for(long seed=1;seed<200;seed++){var p=plan(questions(20),seed,"MEDIUM");for(var h:p.hazards()){if(h.checkpoint()<7){early+=h.tier();ne++;}else if(h.checkpoint()>=15){late+=h.tier();nl++;}}}
        assertTrue(late/nl>early/ne+1,"difficulty rises toward the finish: "+early/ne+" → "+late/nl);
    }

    @Test void noInputMeansNoMovementAndKeysMoveTheRunner(){
        var r=lab(List.of(),null);var p=r.racers.getFirst();
        hold(r,p,0,0,5);assertEquals(0,p.y,1e-9,"standing still: no automatic running");assertEquals(500,p.x,1e-9);
        hold(r,p,0,1,3);assertEquals(MOVE/KY,p.vy,1,"forward at the base run");double y=p.y;assertTrue(y>580&&y<640,"≈ 3 s of running: "+y);
        hold(r,p,0,0,1.2);assertTrue(Math.abs(p.vy)<1,"releasing the key stops the runner");double stopped=p.y;hold(r,p,0,0,2);assertEquals(stopped,p.y,.5);
        hold(r,p,0,-1,2);assertEquals(-MOVE*BACK/KY,p.vy,1,"backward is slower");
        p.x=500;hold(r,p,1,1,.7);double scene=Math.hypot(p.vx*KX,p.vy*KY);assertEquals(MOVE,scene,.05,"a diagonal is no faster than straight");
        hold(r,p,-1,0,3);assertEquals(500-RAIL,p.x,1e-6,"a railing holds the runner on railed road");
    }

    @Test void openEdgesAreRealFallsAndRespawnIsBounded(){
        var gale=new Hazard("GALE",0,1000,1000+GALE_LENGTH,1,0,1,-1,99);
        var r=lab(List.of(gale),null);var p=r.racers.getFirst();
        // Leaning into the wind (a simple counter-steer) crosses the whole narrow bridge without falling.
        for(int k=0;k<120*12;k++){p.horizontal=Math.max(-1,Math.min(1,-(p.x-500)/40));p.forward=1;p.inputAt=r.elapsed;for(var o:r.racers)o.seenAt=r.elapsed;advance(r,STEP);}
        assertTrue(p.y>gale.to(),"crossed: "+p.y);
        var s=lab(List.of(new Hazard("SAWS",0,1000,1000+length("SAWS",1),1,0,1,-1,5)),null);var q=s.racers.getFirst();q.y=1200;
        for(int k=0;k<120*3&&!q.phase.equals("FALLING");k++){q.horizontal=1;q.forward=0;q.inputAt=s.elapsed;for(var o:s.racers)o.seenAt=s.elapsed;advance(s,STEP);}
        assertEquals("FALLING",q.phase,"walking off an open edge falls");assertEquals(1,q.falls);
        hold(s,q,0,0,RushTrials.FALL_TIME+.05);assertEquals("RUNNING",q.phase);assertEquals(1000-RESPAWN_BACK,q.y,1e-6,"back before the zone");assertEquals(500,q.x,1e-9);assertTrue(q.guard>1);
        // Coming off an open span outside the railing line, the railing's end post stops the runner.
        var t=lab(List.of(new Hazard("SAWS",0,1000,1000+length("SAWS",1),1,0,1,-1,5)),null);var u=t.racers.getFirst();u.y=1600;u.x=500+450;u.vy=0;
        hold(t,u,0,1,.6);assertTrue(u.y<=1000+length("SAWS",1)+1e-6||u.phase.equals("FALLING"),"no walking through a railing end: "+u.y);
        assertEquals(0,p.falls,"counter-steering survives the gusts");
    }

    @Test void advancingWallPushesBackButNeverIntoTheObstaclesAndAWrongDoorStaysStone(){
        double rest=6000;var w=new Wall("APPROACH",2,0,600,1,600*1.5/115,1.2,600*1.5/260,0,0,0,0);
        var r=lab(List.of(),w);var p=r.racers.getFirst();p.y=rest-500;
        double min=1e9;
        for(int k=0;k<120*14;k++){p.horizontal=0;p.forward=0;p.inputAt=r.elapsed;for(var o:r.racers)o.seenAt=r.elapsed;advance(r,STEP);
            double planeY=plane(w,rest,r.elapsed);assertTrue(p.y<=planeY-RADIUS+1e-6||p.phase.equals("VALIDATING")||p.phase.equals("OPENING"),"never inside stone");min=Math.min(min,p.y);}
        assertTrue(min>=rest-600-RADIUS-1,"the push is bounded by the wall's travel: "+min);
        // Standing in a door as the wall arrives submits that door; once tried wrong, it is stone.
        var s=lab(List.of(),w);var q=s.racers.getFirst();var question=s.questions.get(0);int wrong=-1;q.y=rest-500;
        for(int i=0;i<3&&wrong<0;i++)if(!question.options().get(order(s,q,0).get(i)).id().equals(question.answerId()))wrong=i;
        q.x=center(wrong,3);
        for(int k=0;k<120*14&&!q.phase.equals("VALIDATING");k++){q.forward=0;q.horizontal=0;q.inputAt=s.elapsed;for(var o:s.racers)o.seenAt=s.elapsed;advance(s,STEP);}
        assertEquals("VALIDATING",q.phase,"the advancing wall brings the door to the runner");assertEquals(wrong,q.selected);
        assertFalse(answer(s,q,question.id(),question.options().get(order(s,q,0).get(wrong)).id()));assertEquals("STUMBLE",q.phase);
        for(int k=0;k<120*3;k++){q.forward=1;q.horizontal=0;q.x=center(wrong,3);q.inputAt=s.elapsed;for(var o:s.racers)o.seenAt=s.elapsed;advance(s,STEP);assertNotEquals("VALIDATING",q.phase,"a sealed door never submits again");}
    }

    @Test void timedShuttersAndSlidingDoors(){
        var timed=new Wall("TIMED",1,0,0,0,0,0,0,0,0,3.8,.62);
        assertFalse(shut(timed,0));assertFalse(shut(timed,3.8*.6));assertTrue(shut(timed,3.8*.7));assertEquals(0,shutter(timed,0),1e-9);assertEquals(1,shutter(timed,3.8*.8),1e-9);
        assertTrue(shutter(timed,3.8*.62-.05)>0,"shutters start to fall before they block (visual leads the collision)");
        var r=lab(List.of(),timed);var p=r.racers.getFirst();p.x=center(1,3);
        // Arrive while shut: bumped, not validated.
        r.elapsed=3.8*.7-.4;p.y=6000-RADIUS-30;hold(r,p,0,1,.3);assertNotEquals("VALIDATING",p.phase);
        var slide=new Wall("SLIDE",2,0,0,0,0,0,0,900.0/3*.3,4.4,0,0);assertEquals(0,slide(slide,0),1e-9);assertEquals(900.0/3*.3,slide(slide,1.1),1e-6);
        // The door is where it slid to: aiming at the unslid centre misses a fully slid door.
        var s=lab(List.of(),slide);var q=s.racers.getFirst();s.elapsed=1.1-.2;q.x=center(1,3)+90;q.y=6000-RADIUS-20;hold(s,q,0,1,.25);assertEquals("VALIDATING",q.phase);assertEquals(1,q.selected);
    }

    @Test void orbsBoostChargeAndShieldOnce(){
        var r=lab(List.of(),null);var p=r.racers.getFirst();
        r.orbs=new ArrayList<>(List.of(new Orb(0,"SPEED",0,500,300,BODY),new Orb(1,"ENERGY",0,500,700,BODY),new Orb(2,"GUARD",0,500,1100,BODY)));
        hold(r,p,0,1,2);assertTrue(p.orbs.contains(0));assertTrue(p.speedUntil>r.elapsed);assertEquals(MOVE*SPEED_ORB/KY,p.vy,2,"speed orb");
        hold(r,p,0,1,3);assertTrue(p.orbs.containsAll(List.of(1,2)));assertEquals(ENERGY_ORB,p.energy,1e-9);assertEquals(1,p.shield);
        int serial=p.orbSerial;hold(r,p,0,-1,6);hold(r,p,0,1,6);assertEquals(serial,p.orbSerial,"each orb is taken once");
        // A shield takes one hit instead of the racer.
        var mill=new Hazard("MILL",0,3000,3620,1,0,1,-1,7);var s=lab(List.of(mill),null);var q=s.racers.getFirst();q.shield=1;q.shieldUntil=99;q.x=800;q.y=millCenter(mill)-10;
        for(int k=0;k<120*6&&q.shieldBlocks==0;k++){q.horizontal=0;q.forward=0;q.inputAt=s.elapsed;for(var o:s.racers)o.seenAt=s.elapsed;advance(s,STEP);}
        assertEquals(1,q.shieldBlocks);assertEquals(0,q.shield);assertNotEquals("KNOCKED",q.phase);
        // An orb over a gap needs a real leap.
        assertFalse(touches(new Orb(9,"SPEED",0,500,1000,BODY+72),500,1000,0));assertTrue(touches(new Orb(9,"SPEED",0,500,1000,BODY+72),500,1000,60));
    }
    static double millCenter(Hazard h){return RushTrials.millCenter(h);}

    @Test void newObstaclesAreDangerousButAlwaysPassable(){
        // Saws: the blade sweeps every lane, and every lane is clear for a while each sweep.
        var saws=new Hazard("SAWS",3,1000,1000+length("SAWS",3),3,.7,1,-1,11);
        for(double x:new double[]{150,500,850}){int hit=0,clear=0;for(double t=0;t<8;t+=.01){if(hit(saws,t,x,sawY(saws,0),0)!=null)hit++;else clear++;}assertTrue(hit>0&&clear>200,"lane "+x+" hit "+hit+" clear "+clear);}
        assertNull(hit(saws,0,sawX(saws,0,0,0),sawY(saws,0)+60,0),"between slots is safe");
        // Crushers: blocks meet, and stay open for a passing window every cycle.
        var crush=new Hazard("CRUSHER",4,1000,1000+length("CRUSHER",4),4,1.1,1,-1,3);
        double open=0;for(double t=0;t<CRUSH_PERIOD[3];t+=.005)if(closure(crush,0,t)<=.04)open+=.005;assertTrue(open>.9,"open window "+open);
        boolean met=false;for(double t=0;t<5;t+=.01)if(closure(crush,0,t)>.99)met=true;assertTrue(met);
        // Crumbling span: a runner at base speed who sets off as the first tile returns crosses dry at every tier.
        for(int tier=1;tier<=4;tier++){var h=new Hazard("CRUMBLE",1,1000,1000+length("CRUMBLE",tier),tier,0,1,-1,5);double period=CRUMBLE_PERIOD[tier-1];
            double t0=CRUMBLE_DOWN*period+.05;boolean dry=true;for(double y=h.from();y<=h.to();y+=2){double t=t0+(y-h.from())/(MOVE/KY);if(falls(List.of(h),500,y,t))dry=false;}
            assertTrue(dry,"tier "+tier+" crumbling span is crossable");}
        // Drifting stones: stones carry the runner; between them is the void.
        var drift=new Hazard("DRIFT",2,1000,1000+length("DRIFT",2),2,0,1,-1,5);double sx=driftX(drift,0,1),sy=driftY(drift,0);
        assertFalse(falls(List.of(drift),sx,sy,1));assertTrue(falls(List.of(drift),sx,sy+DRIFT_GAP/2,1),"the gap between stones is a fall");
        assertEquals(driftVx(drift,0,1),drift(List.of(drift),sx,sy,1,true),1e-9,"a stone carries its rider");
        // Gale: gusts push both ways, bounded below a person's lateral speed.
        var gale=new Hazard("GALE",4,1000,1900,4,0,1,-1,77);boolean left=false,right=false;for(double t=0;t<40;t+=.05){double w=wind(gale,t);if(w>1)right=true;if(w<-1)left=true;assertTrue(Math.abs(w)<MOVE/KX*.7);}
        assertTrue(left&&right);
    }

    @Test void deterministicGoldenValuesForTheBrowserMirror(){
        var saws=new Hazard("SAWS",3,1000,1960,3,.7,1,-1,11);var crush=new Hazard("CRUSHER",2,1000,1720,2,1.1,-1,-1,3);
        var gale=new Hazard("GALE",2,1000,1900,2,.4,1,-1,77);var crumble=new Hazard("CRUMBLE",3,1000,1780,3,2.2,1,-1,5);var drift=new Hazard("DRIFT",4,1000,1725,4,1.3,-1,-1,5);
        var w=new Wall("SURGE",3,1.7,700,2.3,7.7778,1.2,4.0385,90,3.7,0,0);
        double[] g={sawX(saws,1,1,2.345),closure(crush,1,4.21),wind(gale,7.77),crumbleU(crumble,3,5.55),driftX(drift,2,3.33),approach(w,9.1),slide(w,9.1),plane(w,8000,9.1)};
        System.out.println("RUSH_V6_GOLDEN "+Arrays.toString(g));
        for(double v:g)assertTrue(Double.isFinite(v));
    }

    static final Map<String,Integer> FALLS=new TreeMap<>();
    @ParameterizedTest @ValueSource(strings={"EASY","MEDIUM","HARD"})
    void echoBotsFinishReforgedCourses(String level){
        int knocks=0,falls=0,jumps=0;
        for(long seed=1;seed<=4;seed++){
            var r=new Race(questions(8),seed*37,"MEDIUM",REFORGED);for(int i=0;i<5;i++){var p=new Racer("p"+(i+1),null,"Echo "+i,level);p.ready=true;r.racers.add(p);}start(r);
            for(int s=0;s<120*620&&!r.status.equals("FINISHED");s++){advance(r,STEP);for(var p:r.racers){assertTrue(p.z>=0||p.phase.equals("FALLING")||p.phase.equals("DNF"),"z "+p.z+" "+p.phase);assertTrue(p.y>=p.floorY-1e-6,"y "+p.y+" floor "+p.floorY+" "+p.phase+" cp"+p.checkpoint+" t"+r.elapsed);}
                for(var p:r.racers)if(p.phase.equals("FALLING")&&p.phaseTime<=STEP*1.5){var z=RushReforged.zone(RushReforged.hazards(r.hazards,p.checkpoint),p.y);FALLS.merge(level+":"+(z==null?"none":z.kind()+z.tier()),1,Integer::sum);}}
            var detail=new StringBuilder(r.reason+" t="+r.elapsed+" hz="+r.hazards);for(var p:r.racers)detail.append(String.format(" | %s %s cp%d y%.0f x%.0f k%d f%d m%d",p.id,p.phase,p.checkpoint,p.y,p.x,p.knocks,p.falls,p.mistakes));
            int finished=0;for(var p:r.racers){if(p.phase.equals("FINISHED"))finished++;knocks+=p.knocks;falls+=p.falls;jumps+=p.jumps;}
            assertTrue(finished>=(level.equals("EASY")?2:4),"seed "+seed+detail);
        }
        assertTrue(jumps>0,"bots jump");
        System.out.printf("Reforged bots %s: knocks %d, falls %d, jumps %d %s%n",level,knocks,falls,jumps,FALLS);
    }

    @Test void humansNeedInputAndLapsedLeasesStand(){
        var r=race(2,3,"MEDIUM",9,null);var a=r.racers.get(0);double y=a.y;
        for(int k=0;k<120*4;k++){for(var p:r.racers)p.seenAt=r.elapsed;advance(r,STEP);}assertEquals(y,a.y,1e-6,"no input lease → no movement");
        input(r,a,new Input(1,0,null,false,0,0,1));for(int k=0;k<20;k++){for(var p:r.racers)p.seenAt=r.elapsed;advance(r,STEP);}assertTrue(a.y>y);
        double mid=a.y;for(int k=0;k<120;k++){for(var p:r.racers)p.seenAt=r.elapsed;advance(r,STEP);}assertTrue(a.y-mid<120,"a lapsed lease stops the runner");
        assertThrows(RushException.class,()->input(r,a,new Input(2,0,null,false,0,0,2)));
        assertNull(a.target,"version 6 ignores automatic steering targets");input(r,a,new Input(3,0,600.0,false,0,0,0));assertNull(a.target);
    }

    @Test void snapshotsRoundTripTheReforgedPlan()throws Exception{
        var json=new com.fasterxml.jackson.databind.ObjectMapper();var r=race(3,8,"HARD",4,null);
        var back=json.readValue(json.writeValueAsString(r),Race.class);assertEquals(r.walls,back.walls);assertEquals(r.orbs,back.orbs);assertEquals(REFORGED,back.courseVersion);assertTrue(reforged(back));
        var v5=new Race(questions(4),3,"MEDIUM");assertFalse(reforged(v5));assertTrue(trials(v5));
    }

    @Test void persistencePilotJumpsIntoAnApproachingRisingSill(){
        var q=questions(2).getFirst();var w=new Wall("RISING",2,0,0,0,0,0,0,0,0,0,0);
        Map<String,Object> own=Map.of("id","p1","x",500.0,"y",6000.0-RADIUS-40,"z",0.0,"vx",0.0,"vy",MOVE/KY,"checkpoint",0,"phase","RUNNING");
        Map<String,Object> personal=Map.of("vz",0.0,"riseStart",9.6,"dropStart",-1.0,"dropFrom",0.0,"hold",-1.0);
        Map<String,Object> view=Map.of("players",List.of(own),"you","p1","personal",personal,"elapsed",10.0,"hazards",List.of(),
            "walls",List.of(w,still()),"boundaries",List.of(6000.0,12000.0),"question",new RushDtos.Question(q.id(),q.family(),q.prompt(),q.context(),q.options()));
        assertEquals(1,pilot6(view,500)[2],"the persistence pilot must jump rather than repeatedly hit a rising sill");
    }

    /** Test pilot for the persistence suite: the shared steering planner, door alignment and timed/rising walls; on a version 7
     *  course (open edges) the planner's open mode and the stone hop pilot, as the bots use them. Returns {h, f, jump}. */
    @SuppressWarnings("unchecked")
    static double[] pilot6(Map<String,Object> view,double door){
        var players=(List<Map<String,Object>>)view.get("players");String you=(String)view.get("you");
        var own=players.stream().filter(p->p.get("id").equals(you)).findFirst().orElseThrow();var personal=(Map<String,Object>)view.get("personal");
        double x=((Number)own.get("x")).doubleValue(),y=((Number)own.get("y")).doubleValue(),z=((Number)own.get("z")).doubleValue(),t=((Number)view.get("elapsed")).doubleValue();
        double vz=((Number)personal.get("vz")).doubleValue(),vx=((Number)own.get("vx")).doubleValue(),vy=((Number)own.get("vy")).doubleValue();int cp=((Number)own.get("checkpoint")).intValue();
        var hz=hazards((List<Hazard>)view.getOrDefault("hazards",List.of()),cp);var walls=(List<Wall>)view.getOrDefault("walls",List.of());List<Double> rests=(List<Double>)view.get("boundaries");
        Wall w=cp<walls.size()?walls.get(cp):null;double goal=door+(w==null?0:slide(w,t));
        if(!"RUNNING".equals(own.get("phase"))&&!"FINISHING".equals(own.get("phase")))return new double[]{0,0,0};
        boolean open=((Number)view.getOrDefault("courseVersion",REFORGED)).intValue()>=RushCompetition.HARDCORE;
        if(open&&hopping(hz,y)){var s=hopPilot(hz,t,x,y,z,vx,vy,vz);return new double[]{Math.max(-1,Math.min(1,(s[0]-x)/40)),s[1],s[2]>0&&z<=0&&vz<=0?1:0};}
        for(var h:hz)if(y>h.from()-460&&y<h.to()+40){var s=steer(hz,t,x,y,z,vx,vy,vz,goal,open);return new double[]{s.horizontal(),s.forward(),s.leap()?1:0};}
        double h=Math.abs(goal-x)>8?Math.signum(goal-x)*Math.min(1,Math.abs(goal-x)/60):0;
        if(w==null)return new double[]{h,1,0};
        double gap=plane(w,rests.get(cp),t)-RADIUS-y;boolean aligned=Math.abs(goal-x)<=doorHalf(((List<?>)((RushDtos.Question)view.get("question")).options()).size())*.6;
        double f=aligned||gap>160?1:0;if(shut(w,t+Math.max(0,gap)/(MOVE/KY))&&gap<220)f=0;
        boolean jump=false;
        if(w.kind().equals("RISING")&&z<=0&&aligned){
            double arrive=Math.max(0,gap)/Math.max(vy,MOVE/KY);
            double need=RushTrials.sill(((Number)personal.get("riseStart")).doubleValue(),
                ((Number)personal.get("dropStart")).doubleValue(),((Number)personal.get("dropFrom")).doubleValue(),
                ((Number)personal.get("hold")).doubleValue(),t+arrive)-RushTrials.SILL_STEP;
            double height=RushTrials.JUMP_SPEED*arrive-.5*RushTrials.GRAVITY*arrive*arrive;
            jump=need>0&&arrive<=.34&&height>=need;
        }
        return new double[]{h,f,jump?1:0};
    }
}
