package com.englishcoach.quizrush;

import java.util.*;

/**
 * Course version 5 ("Skybound Trials"): obstacle zones, real jumps and dodges, rising Knowledge Gates, knockback,
 * falls and protected recovery. Pure and deterministic — every hazard is a closed-form function of the race clock and
 * the course plan, so the server simulation, the browser mirror ({@code rushTrials.ts}) and every racer agree.
 *
 * Units: x lateral 50–950, y forward, z height (z shares x's scale). Hazard contact is measured in scene units
 * (x × .01, y × .02, z × .01) — the mapping the 3D world draws with — so a hit is exactly what the player sees.
 * A segment is [lead-in · hazard · run-out] + the v4 reading zone scaled to the faster run, so obstacles never
 * spend reading time: the question's own road is always as long, in seconds, as before.
 */
public final class RushTrials {
    public static final int VERSION=5;
    public static final double BASE=212,SPRINT=280,DASH=410,DASH_TIME=.25,RUSH=320,LATERAL=470;
    public static final double JUMP_SPEED=390,GRAVITY=1080,JUMP_BUFFER=.15,JUMP_RECOVER=.15;
    public static final double DODGE_SPEED=1050,DODGE_TIME=.16,DODGE_COOLDOWN=1.4;
    public static final double KNOCK_TIME=.55,HIT_GUARD=1.6,FALL_TIME=1.0,RESPAWN_GUARD=1.4,RESPAWN_BACK=120;
    public static final double READ_PER_WORD=85,READ_BASE=1270,READ_MIN=1800,READ_MAX=4450,LEAD_IN=300,RUNOUT=320;
    public static final double RISE_ZONE=720,RISE_WAIT=2.6,RISE_RATE=57,SILL_MAX=120,SILL_STEP=6,DROP_TIME=.8,REARM=1.2;
    public static final double KX=.01,KY=.02,RS=.28,RUNNER_HEIGHT=1.45;
    public static final double[] LANES={200,500,800};
    public static final List<String> KINDS=List.of("MILL","RAMS","BOULDERS","SKYFALL","CHASM");

    public record Hazard(String kind,int checkpoint,double from,double to,int tier,double phase,int dir,int lane,int salt) {}
    public record Plan(List<Double> boundaries,List<Hazard> hazards,List<Boolean> rising) {}
    public record Hit(double vx,double vy) {}

    /** Jump apex (z units): the highest sill a racer can step into is apex + SILL_STEP. */
    public static double apex(){return JUMP_SPEED*JUMP_SPEED/(2*GRAVITY);}
    /** v4's 80 units/word at 200 → 85 at 212: the same reading seconds on the faster road. */
    public static double readingLength(RushQuestions.Pinned q){
        var text=new StringBuilder(q.prompt()).append(' ').append(q.context());for(var o:q.options())text.append(' ').append(o.label());
        int words=text.toString().trim().split("\\s+").length;return Math.max(READ_MIN,Math.min(READ_MAX,READ_BASE+READ_PER_WORD*words));
    }
    public static double length(String kind,int tier){
        return switch(kind){case "MILL"->620;case "RAMS"->880;case "BOULDERS"->1500;case "SKYFALL"->tier==1?1000:1300;case "CHASM"->520;default->0;};
    }

    /**
     * Course plan. The first segment is always clear (learn the controls); at most two hazard segments in a row; kinds
     * rotate through a shuffle bag that unlocks the harder kinds with progress; intensity (tier 1–3) grows with
     * progress and the chosen difficulty. Rising gates never follow each other and never guard the first wall.
     */
    public static Plan plan(List<RushQuestions.Pinned> questions,long seed,String difficulty){
        var random=new Random(seed^0x5CB1A7E5L);int n=questions.size();
        double density=switch(Objects.toString(difficulty,"MEDIUM")){case "EASY"->.55;case "HARD"->.85;default->.7;};
        int shift=switch(Objects.toString(difficulty,"MEDIUM")){case "EASY"->-1;case "HARD"->1;default->0;};
        double rise=switch(Objects.toString(difficulty,"MEDIUM")){case "EASY"->.2;case "HARD"->.4;default->.3;};
        var boundaries=new ArrayList<Double>();var hazards=new ArrayList<Hazard>();var rising=new ArrayList<Boolean>();
        var bag=new ArrayList<String>();String previous="";int run=0,clear=0;double at=0;
        for(int i=0;i<n;i++){
            double p=n<=1?1:(double)i/(n-1);boolean want=i>0&&(run<2&&(clear>=2||random.nextDouble()<density||n<=3&&hazards.isEmpty()));
            Hazard hazard=null;
            if(want){
                var unlocked=p<.34?List.of("CHASM","MILL","RAMS"):p<.67?List.of("CHASM","MILL","RAMS","BOULDERS"):KINDS;
                bag.removeIf(k->!unlocked.contains(k));if(bag.isEmpty()){bag.addAll(unlocked);Collections.shuffle(bag,random);}
                int pick=0;while(pick<bag.size()-1&&bag.get(pick).equals(previous))pick++;String kind=bag.remove(pick);
                int tier=Math.max(1,Math.min(3,(p<.4?1:p<.75?2:3)+shift));
                double from=at+LEAD_IN;
                hazard=new Hazard(kind,i,from,from+length(kind,tier),tier,random.nextDouble()*Math.PI*2,random.nextBoolean()?1:-1,
                    kind.equals("CHASM")&&tier<3?random.nextInt(3):-1,random.nextInt(Integer.MAX_VALUE));
                hazards.add(hazard);previous=kind;run++;clear=0;
            }else{run=0;clear++;}
            at+=(hazard==null?0:LEAD_IN+length(hazard.kind(),hazard.tier())+RUNOUT)+readingLength(questions.get(i));boundaries.add(at);
            boolean grand=i==n-1&&n>1;
            rising.add(i>0&&!(i>0&&rising.get(i-1))&&random.nextDouble()<(grand?(shift<0?.25:.5):rise));
        }
        return new Plan(List.copyOf(boundaries),List.copyOf(hazards),List.copyOf(rising));
    }
    public static Hazard hazard(List<Hazard> hazards,int checkpoint){if(hazards==null)return null;for(var h:hazards)if(h.checkpoint()==checkpoint)return h;return null;}
    public static boolean rising(List<Boolean> rising,int checkpoint){return rising!=null&&checkpoint>=0&&checkpoint<rising.size()&&Boolean.TRUE.equals(rising.get(checkpoint));}

    static int mix(int h){h^=h>>>16;h*=0x85ebca6b;h^=h>>>13;h*=0xc2b2ae35;h^=h>>>16;return h;}
    static double side(double v,double fallback){return v>0?1:v<0?-1:fallback;}

    /** A collision with a moving hazard, or null. Chasm falls are separate ({@link #falls}). */
    public static Hit hit(Hazard h,double t,double x,double y,double z){
        if(h==null||y<h.from()-120||y>h.to()+120)return null;
        return switch(h.kind()){case "MILL"->mill(h,t,x,y,z);case "RAMS"->rams(h,t,x,y,z);case "BOULDERS"->boulders(h,t,x,y);case "SKYFALL"->skyfall(h,t,x,y);default->null;};
    }

    // ── Rune Mill: a double-ended beam spinning flat at shin height around a crystal pillar. Jump it. ──
    public static final double MILL_ARM=4.7,MILL_THICK=.2,MILL_TOP=46,MILL_PILLAR=.42;
    /** Tier 4 exists only on course version 6+ (RushReforged), tiers 5–6 only on version 7; version 5 plans never go above tier 3. */
    public static final double[] MILL_SPIN={1.1,1.35,1.6,1.95,2.3,2.7};
    public static double millCenter(Hazard h){return (h.from()+h.to())/2;}
    public static double millAngle(Hazard h,double t){return h.phase()+h.dir()*MILL_SPIN[h.tier()-1]*t;}
    static Hit mill(Hazard h,double t,double x,double y,double z){
        if(z>=MILL_TOP)return null;
        double px=(x-500)*KX,py=(y-millCenter(h))*KY,a=millAngle(h,t),ux=Math.cos(a),uy=Math.sin(a);
        double s=px*ux+py*uy,perp=Math.abs(px*uy-py*ux);
        if(Math.abs(s)>MILL_ARM+RS||perp>MILL_THICK+RS)return null;
        double w=h.dir()*MILL_SPIN[h.tier()-1],vx=-w*py;
        return new Hit(side(vx,side(px,1))*380,-200);
    }
    /** The pillar is solid: a runner meeting it slides around it (no penalty). Returns the corrected x. */
    public static double millPillar(Hazard h,double x,double y){
        if(h==null||!h.kind().equals("MILL"))return x;
        double py=(y-millCenter(h))*KY,min=MILL_PILLAR+RS;if(Math.abs(py)>=min)return x;
        double px=(x-500)*KX,need=Math.sqrt(min*min-py*py);if(Math.abs(px)>=need)return x;
        return 500+(px<0?-need:need)/KX;
    }

    // ── Swinging rams: three iron-banded logs hung from arches, swinging across the road. Time the gap or pass under. ──
    public static final double RAM_REACH=6.0,RAM_SWING=4.0,RAM_HALF_X=.45,RAM_HALF_Y=.55,RAM_LOW=.15,RAM_HIGH=1.35,RAM_GAP=280;
    public static final double[] RAM_SPEED={1.7,2.05,2.4,2.8,3.2,3.6};
    public static double ramY(Hazard h,int j){return h.from()+160+j*RAM_GAP;}
    public static double ramPhase(Hazard h,int j,double t){return h.phase()+j*1.9+h.dir()*RAM_SPEED[h.tier()-1]*t;}
    /** Scene-x offset of ram j from the road centre. */
    public static double ramOffset(Hazard h,int j,double t){return ramSwing(h)*Math.sin(ramPhase(h,j,t));}
    /** Version 7 tiers 5–6 swing wider (still inside the reach, so the arc stays a real pendulum). */
    public static double ramSwing(Hazard h){return h.tier()>=5?4.45:RAM_SWING;}
    /** Height gained by the ram on its arc (scene units): low at the bottom of the swing, high at the ends. */
    public static double ramLift(double offset){return RAM_REACH-Math.sqrt(RAM_REACH*RAM_REACH-offset*offset);}
    static Hit rams(Hazard h,double t,double x,double y,double z){
        double px=(x-500)*KX,rz=z*KX;
        for(int j=0;j<3;j++){
            if(Math.abs((y-ramY(h,j))*KY)>RAM_HALF_Y+RS)continue;
            double off=ramOffset(h,j,t);if(Math.abs(px-off)>RAM_HALF_X+RS)continue;
            double lift=ramLift(off);if(lift+RAM_LOW>rz+RUNNER_HEIGHT||lift+RAM_HIGH<rz)continue;
            double v=h.dir()*Math.cos(ramPhase(h,j,t));return new Hit(side(v,side(px-off,1))*420,-150);
        }
        return null;
    }

    // ── Stonefall Run: rune boulders roll down the causeway one lane at a time. Change lanes. ──
    public static final double BOULDER_R=.62;
    public static final double[] BOULDER_SPEED={300,350,400,450,500,550},BOULDER_EVERY={1.35,1.15,1.0,.88,.8,.72};
    public record Boulder(double x,double y,int k,double roll) {}
    public static double boulderStart(Hazard h){return h.to()+100;}
    public static double boulderEnd(Hazard h){return h.from()-80;}
    public static int boulderLane(Hazard h,int k,int pair){int lane=Math.floorMod(mix(h.salt()+k*0x9E3779B9),3);return pair==0?lane:(lane+1)%3;}
    /**
     * Version 7 tiers 5–6: a boulder may roll anywhere across the road (on the three lanes, standing between two lanes was
     * always safe); a pair keeps BOULDER_PAIR apart, so open road always remains beside or between them.
     */
    public static final double BOULDER_PAIR=330;
    public static double boulderX(Hazard h,int k,int pair){
        if(h.tier()<5)return LANES[boulderLane(h,k,pair)];double x=160+Math.floorMod(mix(h.salt()+k*0x9E3779B9),681);
        return pair==0?x:x+BOULDER_PAIR<=840?x+BOULDER_PAIR:x-BOULDER_PAIR;
    }
    public static int boulderPairs(Hazard h,int k){return (h.tier()==3?Math.floorMod(k,4)==3:h.tier()==4?Math.floorMod(k,3)==2:h.tier()>=5&&Math.floorMod(k,2)==1)?2:1;}
    /** Boulders on the road at time t (pairs on tier 3 every fourth roll — one lane always stays free). */
    public static List<Boulder> boulders(Hazard h,double t){
        var out=new ArrayList<Boulder>();double v=BOULDER_SPEED[h.tier()-1],every=BOULDER_EVERY[h.tier()-1],span=boulderStart(h)-boulderEnd(h);
        int last=(int)Math.floor((t-h.phase())/every),first=(int)Math.ceil((t-h.phase()-span/v)/every);
        for(int k=first;k<=last;k++){double age=t-(h.phase()+k*every),y=boulderStart(h)-v*age;if(age<0||y<boulderEnd(h))continue;
            int pairs=boulderPairs(h,k);for(int q=0;q<pairs;q++)out.add(new Boulder(boulderX(h,k,q),y,k,v*age*KY/BOULDER_R));}
        return out;
    }
    static Hit boulders(Hazard h,double t,double x,double y){
        for(var b:boulders(h,t)){double dx=(x-b.x())*KX,dy=(y-b.y())*KY;if(dx*dx+dy*dy<=(BOULDER_R+RS)*(BOULDER_R+RS))return new Hit(side(dx,1)*220,-(BOULDER_SPEED[h.tier()-1]+150));}
        return null;
    }

    // ── Skyfall: rows of falling sky-stones. Glowing circles mark two lanes a second before impact; the gaps are safe. ──
    public static final double FALL_RADIUS=1.05,FALL_WARN=1.0,FALL_BEFORE=.05,FALL_AFTER=.2,FALL_ROW_GAP=300,FALL_STAGGER=.8;
    public static final double[] FALL_PERIOD={2.6,2.3,2.0,1.8,1.6,1.45};
    public record Impact(int row,int n,double time,double y,int safe) {}
    public static int rows(Hazard h){return h.tier()==1?3:h.tier()>=5?5:4;}
    public static double rowY(Hazard h,int j){return h.from()+200+j*FALL_ROW_GAP;}
    public static int safeLane(Hazard h,int row,int n){return Math.floorMod(mix(h.salt()^(row*7919+n*104729)),3);}
    /** The impact of each row whose warning / landing window contains t (at most one per row). */
    public static List<Impact> impacts(Hazard h,double t){
        var out=new ArrayList<Impact>();double period=FALL_PERIOD[h.tier()-1];
        for(int j=0;j<rows(h);j++){double base=h.phase()+j*FALL_STAGGER;int n=(int)Math.ceil((t-base-FALL_AFTER-.4)/period);double at=base+n*period;
            if(t>=at-FALL_WARN)out.add(new Impact(j,n,at,rowY(h,j),safeLane(h,j,n)));}
        return out;
    }
    static Hit skyfall(Hazard h,double t,double x,double y){
        for(var i:impacts(h,t)){if(t<i.time()-FALL_BEFORE||t>i.time()+FALL_AFTER)continue;
            for(int lane=0;lane<3;lane++){if(lane==i.safe())continue;double dx=(x-LANES[lane])*KX,dy=(y-i.y())*KY;
                if(dx*dx+dy*dy<=(FALL_RADIUS+RS)*(FALL_RADIUS+RS))return new Hit(side(dx,1)*300,-220);}}
        return null;
    }

    // ── Broken bridge: a gap across the road; jump it, or (tiers 1–2) cross the narrow beam. ──
    public static final double[] CHASM_HALF={40,46,52,56,60,64};
    public static final double CHASM_GRACE=14,BEAM_HALF=34;
    public static double chasmCenter(Hazard h){return (h.from()+h.to())/2;}
    public static boolean falls(Hazard h,double x,double y){
        if(h==null||!h.kind().equals("CHASM"))return false;
        if(Math.abs(y-chasmCenter(h))>=CHASM_HALF[h.tier()-1]-CHASM_GRACE)return false;
        return h.lane()<0||Math.abs(x-LANES[h.lane()])>BEAM_HALF;
    }
    public static double respawnY(Hazard h){return h.kind().equals("CHASM")?chasmCenter(h)-CHASM_HALF[h.tier()-1]-RESPAWN_BACK:h.from()-RESPAWN_BACK;}

    // ── Rising Knowledge Gate: the wall lifts on its plinth; leap into the doorway before its sill is out of reach. ──
    /** Sill height (z units). riseStart < 0: dormant; hold ≥ 0: frozen while the server checks an answer. */
    public static double sill(double riseStart,double dropStart,double dropFrom,double hold,double t){
        if(hold>=0)return hold;if(riseStart<0)return 0;
        if(dropStart>=0&&t<dropStart+DROP_TIME)return dropFrom*(1-(t-dropStart)/DROP_TIME);
        return Math.min(SILL_MAX,Math.max(0,(t-riseStart)*RISE_RATE));
    }

    /**
     * Earliest predicted contact (seconds) for a runner heading from x0 toward xTarget at the lateral speed while
     * running at `speed` on the ground; +∞ when the path is clear for `horizon`. Used by Echo Bots only.
     */
    public static double threat(Hazard h,double t,double x0,double xTarget,double y0,double speed,double horizon){
        for(double tau=0;tau<=horizon+1e-9;tau+=.05){
            double x=x0+Math.signum(xTarget-x0)*Math.min(Math.abs(xTarget-x0),LATERAL*tau),y=y0+speed*tau;
            if(h.kind().equals("CHASM")?falls(h,x,y):hit(h,t+tau,x,y,0)!=null)return tau;
        }
        return Double.POSITIVE_INFINITY;
    }
    private RushTrials(){}
}
