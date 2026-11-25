package com.englishcoach.quizrush;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.quizrush.RushCompetition.*;
import static com.englishcoach.quizrush.RushReforged.*;
import static com.englishcoach.quizrush.RushTrials.Hazard;
import static com.englishcoach.quizrush.RushTrials.Hit;

/**
 * Course version 7 (Hardcore): no railings, open-edge falls everywhere, harder tiers 5–6, momentum falls, knocks into the
 * abyss, the four new obstacles, the version 7 plan and Echo Bots that finish it; version 6 races keep their rails.
 */
class RushHardcoreTest {
    static List<RushQuestions.Pinned> questions(int n){return RushTrialsTest.questions(n);}
    static Race race(int gates,String difficulty,long seed,int version,String bot,int racers){
        var r=new Race(questions(gates),seed,difficulty,version);
        for(int i=0;i<racers;i++){var p=new Racer("p"+(i+1),bot==null?(long)i+1:null,"Racer "+i,bot);p.ready=true;r.racers.add(p);}
        start(r);advance(r,3.01);return r;
    }
    /** One segment of our choosing on a course of the given version. */
    static Race lab(int version,List<Hazard> hazards){
        var r=race(2,"MEDIUM",5,version,null,2);r.hazards=new ArrayList<>(hazards);
        r.walls=new ArrayList<>(List.of(RushReforgedTest.still(),RushReforgedTest.still()));r.rising=new ArrayList<>(List.of(false,false));
        r.boundaries=new ArrayList<>(List.of(6000.0,12000.0));r.orbs=new ArrayList<>();
        for(var p:r.racers){p.y=0;p.x=500;p.floorY=-80;p.vx=p.vy=0;p.phase="RUNNING";p.lastSlide=0;}
        return r;
    }
    static void hold(Race r,Racer p,double h,double f,double seconds){RushReforgedTest.hold(r,p,h,f,seconds);}
    static void knock(Race r,Racer p,Hit hit){
        try{var m=RushCompetition.class.getDeclaredMethod("knock",Race.class,Racer.class,Hit.class);m.setAccessible(true);m.invoke(null,r,p,hit);}catch(ReflectiveOperationException e){throw new AssertionError(e);}
    }

    @Test void newRacesAreVersionSeven(){
        var r=race(3,"MEDIUM",1,RushCompetition.HARDCORE,null,2);assertEquals(7,r.courseVersion);assertTrue(hardcore(r));assertTrue(reforged(r));
        var old=race(3,"MEDIUM",1,REFORGED,null,2);assertEquals(6,old.courseVersion);assertFalse(hardcore(old));assertTrue(reforged(old));
    }

    @Test void browserMirrorAnswersEveryProbeLikeTheAuthority()throws IOException{
        int n=0,hits=0;
        try(var in=new BufferedReader(new InputStreamReader(Objects.requireNonNull(getClass().getResourceAsStream("/quizrush/v7-probes.csv")),StandardCharsets.UTF_8))){
            in.readLine();String line;
            while((line=in.readLine())!=null){
                var c=line.split(",",-1);
                var h=new Hazard(c[0],0,Double.parseDouble(c[5]),Double.parseDouble(c[6]),Integer.parseInt(c[1]),Double.parseDouble(c[2]),Integer.parseInt(c[3]),-1,Integer.parseInt(c[4]));
                double t=Double.parseDouble(c[7]),x=Double.parseDouble(c[8]),y=Double.parseDouble(c[9]),z=Double.parseDouble(c[10]);
                var hit=RushReforged.hit(h,t,x,y,z);String where=line;
                if(c[11].isEmpty())assertNull(hit,"no hit "+where);
                else{assertNotNull(hit,"hit "+where);assertEquals(Integer.parseInt(c[11]),(int)Math.signum(hit.vx()),"side "+where);assertEquals(Double.parseDouble(c[12]),hit.vy(),1e-9,"vy "+where);hits++;}
                assertEquals(Boolean.parseBoolean(c[13]),RushReforged.falls(List.of(h),x,y,t,true),"falls "+where);
                assertEquals(Double.parseDouble(c[14]),RushReforged.drift(List.of(h),x,y,t,z<=0),1e-6,"drift "+where);
                n++;
            }
        }
        assertTrue(n>5000,"probes "+n);assertTrue(hits>300,"hits "+hits);
    }

    @Test void plainRoadEdgesAreRealDropsOnlyOnVersionSeven(){
        // Version 7: walking off the side of ordinary road (no obstacle zone) falls, keeps its momentum, and respawns on the road.
        var r=lab(RushCompetition.HARDCORE,List.of());var p=r.racers.getFirst();p.y=600;p.x=900;
        double fallX=0;for(double t=0;t<1.5&&!p.phase.equals("FALLING");t+=STEP)hold(r,p,1,0,STEP);
        assertEquals("FALLING",p.phase);assertTrue(p.fallX>500+EDGE,"left the road at "+p.fallX);fallX=p.x;assertTrue(p.kvx>0,"keeps sideways momentum");
        hold(r,p,0,0,.3);assertTrue(p.x>fallX,"the body carries on outward while it falls");
        hold(r,p,0,0,1.0);assertEquals("RUNNING",p.phase);assertTrue(Math.abs(p.x-500)<=RESPAWN_SIDE+1e-6,"back on the road "+p.x);assertEquals(600-RESPAWN_BACK,p.y,1e-6);assertTrue(p.guard>0);
        // Version 6: the railing still holds outside obstacle zones.
        var old=lab(REFORGED,List.of());var q=old.racers.getFirst();q.y=600;q.x=900;
        hold(old,q,1,0,1.5);assertEquals("RUNNING",q.phase);assertEquals(500+RAIL,q.x,1e-6);
    }

    @Test void knocksNearAnEdgeThrowRunnersIntoTheAbyss(){
        // A runner standing near the edge takes a sideways hit toward it: the version 7 knock carries them over the edge.
        var near=lab(RushCompetition.HARDCORE,List.of());var victim=near.racers.getFirst();victim.x=900;victim.y=600;
        knock(near,victim,new Hit(380,-200));for(double t=0;t<1.2&&!victim.phase.equals("FALLING");t+=STEP)hold(near,victim,0,0,STEP);
        assertEquals("FALLING",victim.phase,"thrown into the abyss");assertEquals(1,victim.knocks);
        // The same hit on a version 6 course is caught by the railing.
        var railed=lab(REFORGED,List.of());var safe=railed.racers.getFirst();safe.x=900;safe.y=600;
        knock(railed,safe,new Hit(380,-200));hold(railed,safe,0,0,1.2);assertEquals("RUNNING",safe.phase);assertEquals(500+RAIL,safe.x,1e-6);
        var r=lab(RushCompetition.HARDCORE,List.of());var p=r.racers.getFirst();
        knock(r,p,new Hit(380,-200));
        assertEquals(380*KNOCK7_X,p.kvx,1e-9);assertEquals(-200*KNOCK7_Y,p.kvy,1e-9);
    }

    @Test void strongerStrikesAndWindAreFeltAndStayFair(){
        // Repair 2026-10-25 (owner: hazards felt weak). A sideways strike 150 units from an open edge throws the runner into
        // the abyss; at ×1.55 / ×1.2 it left them on the road.
        var r=lab(RushCompetition.HARDCORE,List.of());var p=r.racers.getFirst();p.x=820;p.y=600;
        knock(r,p,new Hit(380,-200));for(double t=0;t<1.2&&!p.phase.equals("FALLING");t+=STEP)hold(r,p,0,0,STEP);
        assertEquals("FALLING",p.phase,"a strong strike near the edge throws the runner off");
        // The same strike in the middle of the wide road: a long, readable slide that stays on the road.
        var c=lab(RushCompetition.HARDCORE,List.of());var q=c.racers.getFirst();q.x=500;q.y=600;
        knock(c,q,new Hit(380,-200));hold(c,q,0,0,1.2);assertEquals("RUNNING",q.phase);assertTrue(q.x-500>140&&q.x-500<EDGE,"slide "+(q.x-500));
        // Wind Balance Bridge, top tier: a full gust blows a runner who does nothing off the beam; steering into it holds the line.
        var beam=new Hazard("BEAM",0,1000,1000+length("BEAM",6),6,0,1,-1,3);double t0=.01;while(gust(beam,t0)<1e-9||gust(beam,t0-.01)>1e-9)t0+=.01;
        int dir=(int)Math.signum(wind(beam,t0+.2));assertNotEquals(0,dir);
        var still=lab(RushCompetition.HARDCORE,List.of(beam));still.elapsed=t0;var idle=still.racers.getFirst();idle.y=1500;hold(still,idle,0,0,1.0);
        assertEquals("FALLING",idle.phase,"a runner who does nothing is blown off");
        // A player who reacts 0.25 s after the gust starts, steers into it while it blows and re-centres afterwards stays on.
        var w=lab(RushCompetition.HARDCORE,List.of(beam));w.elapsed=t0;var b=w.racers.getFirst();b.y=1500;hold(w,b,0,0,.25);
        for(int k=0;k<40;k++){double gust=wind(beam,w.elapsed);hold(w,b,Math.abs(gust)>1?-Math.signum(gust):Math.max(-1,Math.min(1,(500-b.x)/60)),0,.05);}
        assertEquals("RUNNING",b.phase,"a human reaction to the strongest gust holds the beam, x="+b.x);
        for(int tier=1;tier<=6;tier++)assertTrue(BEAM_FORCE[tier-1]*.31<BEAM_HALF[tier-1],"tier "+tier+": a gust met late never throws by itself");
    }

    @Test void newObstaclesBehaveAsDrawn(){
        // Stepping stones: walking off the first stone falls; a sinking stone is down only part of each cycle.
        var steps=new Hazard("STEPS",0,1000,1000+length("STEPS",3),3,.4,1,-1,99);
        assertFalse(falls(List.of(steps),stepX(steps,0),stepY(steps,0),0,true));assertTrue(falls(List.of(steps),stepX(steps,0),stepY(steps,0)+STEP_R[2]/KY+5,0,true));
        int down=0;for(double t=0;t<STEP_SINK[2];t+=.01)if(stepDown(steps,1,t))down++;assertEquals(STEP_DOWN,down/(STEP_SINK[2]/.01),.02);
        for(double t=0;t<20;t+=.05)assertFalse(stepDown(steps,0,t)||stepDown(steps,2,t),"even stones never sink");
        // Tilting road: a standing runner slides toward the low edge, steering uphill wins.
        var tilt=new Hazard("TILT",0,1000,1000+length("TILT",4),4,0,1,-1,7);
        var r=lab(RushCompetition.HARDCORE,List.of(tilt));var p=r.racers.getFirst();p.y=1150;hold(r,p,0,0,1.2);assertTrue(p.x>520,"slid toward +x: "+p.x);
        var r2=lab(RushCompetition.HARDCORE,List.of(tilt));var p2=r2.racers.getFirst();p2.y=1150;hold(r2,p2,-1,0,1.2);assertTrue(p2.x<500,"uphill steering beats the slide: "+p2.x);
        assertTrue(Math.abs(tiltAngle(tilt,tilt.from()+TILT_SEG*.5)+tiltAngle(tilt,tilt.from()+TILT_SEG*1.5))<1e-9,"tier 3+ sections alternate");
        // Wind Balance Bridge: narrower than the gale bridge, and a gust pushes.
        var beam=new Hazard("BEAM",0,1000,1000+length("BEAM",6),6,0,1,-1,3);
        assertTrue(BEAM_HALF[5]<galeHalf(new Hazard("GALE",0,0,900,6,0,1,-1,1)));assertTrue(falls(List.of(beam),500+BEAM_HALF[5]+1,1200,0,true));
        double push=0;for(double t=0;t<5;t+=.05)push=Math.max(push,Math.abs(wind(beam,t)));assertEquals(BEAM_FORCE[5],push,1e-9);
        // Spiked roller: only the logs (and the tier 3 pad) carry a runner; standing on a log, its surface carries you sideways.
        for(int tier=1;tier<=6;tier++){var h=new Hazard("ROLLER",0,1000,1000+length("ROLLER",tier),tier,0,1,-1,5);
            for(int i=0;i<logCount(h);i++){double y=(logFrom(h,i)+logTo(h,i))/2;assertTrue(rollerSupport(h,logX(h,i),y));assertFalse(rollerSupport(h,logX(h,i)+ROLL_SUPPORT/KX+3,y));
                assertEquals(logDir(h,i)*ROLL_SPIN[tier-1]*ROLL_R/KX,rollerCarry(h,logX(h,i),y),1e-9);}
            if(tier>=3)assertEquals(rollerPad(h),rollerSupport(h,500,(h.from()+h.to())/2),"a pad on tiers 3–4, a void to leap on 5–6");}
        // A peg sweeping over the top meets a runner standing there; a high enough hop clears it.
        var roll=new Hazard("ROLLER",0,1000,1000+length("ROLLER",1),1,0,1,-1,5);double ry=ringY(roll,0,2);int met=0,cleared=0;
        for(double t=0;t<8;t+=.01){if(RushReforged.hit(roll,t,500,ry,0)!=null)met++;if(RushReforged.hit(roll,t,500,ry,60)!=null)cleared++;}
        assertTrue(met>0,"a peg meets a standing runner");assertEquals(0,cleared,"a hop of 60 clears every peg");
        // Tier 5–6 crushers: a one-sided ram shoves toward the far edge and leaves a strip by that edge open.
        var crush=new Hazard("CRUSHER",0,1000,1000+length("CRUSHER",5),5,0,1,-1,8);int s=crushSide(crush,1);
        Hit shove=null;for(double t=0;t<3&&shove==null;t+=.01)shove=RushReforged.hit(crush,t,500,crushY(crush,1),0);
        assertNotNull(shove);assertEquals(-s,(int)Math.signum(shove.vx()));
        for(double t=0;t<3;t+=.01)assertNull(RushReforged.hit(crush,t,500-s*(EDGE-10),crushY(crush,1),0),"the far edge strip stays open");
    }

    @Test void versionSevenPlanEscalatesAndEndsOnTheRollers(){
        var seen=new HashSet<String>();int maxTier=0;
        for(long seed=1;seed<240;seed++)for(String d:List.of("EASY","MEDIUM","HARD"))for(int n:List.of(3,8,12,20)){
            var qs=questions(n);var plan=plan(qs,seed,d,RushCompetition.HARDCORE);
            assertEquals(n,plan.boundaries().size());assertEquals(n,plan.walls().size());assertTrue(hazards(plan.hazards(),0).isEmpty(),"first segment clear");
            var last=hazards(plan.hazards(),n-1);assertFalse(last.isEmpty());assertEquals("ROLLER",last.getLast().kind(),"signature finale");
            if(d.equals("EASY"))assertEquals(1,last.size());else assertEquals(2,last.size());
            int run=0;for(int i=0;i<n;i++){run=hazards(plan.hazards(),i).isEmpty()?0:run+1;assertTrue(run<=(d.equals("EASY")?3:4)||i==n-1);}
            for(int i=0;i<n;i++){
                double start=i==0?0:plan.boundaries().get(i-1),wall=plan.boundaries().get(i),reading=readingLength(qs.get(i));
                var mine=hazards(plan.hazards(),i);double prev=start;
                for(var h:mine){assertTrue(h.from()>=prev+(prev==start?LEAD_IN:BETWEEN)-1e-6,"plain road before every obstacle");assertTrue(h.tier()>=1&&h.tier()<=(d.equals("EASY")?4:6));prev=h.to();seen.add(h.kind());maxTier=Math.max(maxTier,h.tier());}
                assertTrue(wall-prev>=reading-1e-6,"the reading approach is kept whole");
                var w=plan.walls().get(i);assertTrue(w.travel()<=Math.max(0,reading-WALL_ROOM)+1e-6);
            }
        }
        assertTrue(seen.containsAll(KINDS7),"every kind appears: "+seen);assertEquals(6,maxTier);
        var a=plan(questions(8),11,"HARD",RushCompetition.HARDCORE);var b=plan(questions(8),11,"HARD",RushCompetition.HARDCORE);assertEquals(a,b,"deterministic");
        assertNotEquals(plan(questions(8),11,"HARD",REFORGED),a,"version 6 keeps its own plan");
    }

    /** The shared steering planner as a careful pilot on one obstacle: falls and seconds to get past it (−1: never). */
    static double[] pilotThrough(Hazard h){
        var r=lab(RushCompetition.HARDCORE,List.of(h));var p=r.racers.getFirst();p.y=h.from()-200;var hz=List.of(h);double next=0;
        while(r.elapsed<90){
            if(hopping(hz,p.y)){var s=hopPilot(hz,r.elapsed,p.x,p.y,p.z,p.vx,p.vy,p.vz);p.forward=s[1];p.botTargetX=s[0];if(s[2]>0&&p.z<=0&&p.vz<=0&&p.jumpAt<0)p.jumpAt=r.elapsed;}
            else if(r.elapsed>=next){next=r.elapsed+.1;var s=steer(hz,r.elapsed,p.x,p.y,p.z,p.vx,p.vy,p.vz,500,true);
                p.forward=s.forward();p.botTargetX=s.target();if(s.leap()&&p.z<=0&&p.vz<=0)p.jumpAt=r.elapsed;}
            p.horizontal=Math.max(-1,Math.min(1,(p.botTargetX-p.x)/40));p.inputAt=r.elapsed;for(var o:r.racers)o.seenAt=r.elapsed;advance(r,STEP);
            if(p.y>h.to()+80&&p.phase.equals("RUNNING"))return new double[]{p.falls,r.elapsed};
        }
        return new double[]{p.falls,-1};
    }
    @Test void everyObstacleIsCrossableByACarefulPilot(){
        var report=new StringBuilder();int stuck=0;
        for(String kind:KINDS7)for(int tier=1;tier<=6;tier++){
            for(long salt=1;salt<=3;salt++){var h=new Hazard(kind,0,1000,1000+length(kind,tier),tier,salt*.9,salt%2==0?1:-1,kind.equals("CHASM")&&tier<3?1:-1,(int)(salt*7919));
                var res=pilotThrough(h);report.append(String.format("%s%d/%d:%s ",kind,tier,salt,res[1]<0?"STUCK f"+(int)res[0]:String.format("%.0fs f%d",res[1],(int)res[0])));if(res[1]<0)stuck++;}
        }
        System.out.println("PILOT "+report);
        assertEquals(0,stuck,report.toString());
    }

    static final Map<String,Integer> FALLS=new TreeMap<>();
    @ParameterizedTest @ValueSource(strings={"EASY","MEDIUM","HARD"})
    void echoBotsFinishHardcoreCourses(String level){
        int knocks=0,falls=0,jumps=0,finished=0;double time=0;
        for(long seed=1;seed<=4;seed++){
            var r=new Race(questions(8),seed*41,"MEDIUM",RushCompetition.HARDCORE);for(int i=0;i<5;i++){var p=new Racer("p"+(i+1),null,"Echo "+i,level);p.ready=true;r.racers.add(p);}start(r);
            for(int s=0;s<120*620&&!r.status.equals("FINISHED");s++){advance(r,STEP);
                for(var p:r.racers){assertTrue(p.y>=p.floorY-1e-6,"floor");if(p.phase.equals("FALLING")&&p.phaseTime<=STEP*1.5){var z=zone(hazards(r.hazards,p.checkpoint),p.fallY);FALLS.merge(level+":"+(z==null?"edge":z.kind()+z.tier()),1,Integer::sum);}}}
            for(var p:r.racers){if(p.phase.equals("FINISHED")){finished++;time+=p.finishAt;}knocks+=p.knocks;falls+=p.falls;jumps+=p.jumps;}
        }
        assertTrue(finished>=(level.equals("EASY")?10:16),level+" finished "+finished+"/20 "+FALLS);
        assertTrue(jumps>0);
        if(level.equals("EASY"))assertTrue(falls+knocks>0,"easy bots make mistakes");
        System.out.printf("Hardcore bots %s: finished %d/20 mean %.1fs, knocks %d, falls %d, jumps %d %s%n",level,finished,time/Math.max(1,finished),knocks,falls,jumps,FALLS);
    }
}
