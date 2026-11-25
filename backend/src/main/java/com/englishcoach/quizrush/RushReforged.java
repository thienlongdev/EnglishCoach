package com.englishcoach.quizrush;

import java.util.*;
import static com.englishcoach.quizrush.RushTrials.Hazard;
import static com.englishcoach.quizrush.RushTrials.Hit;

/**
 * Course version 6 ("Reforged"): manual third-person movement, real open edges, moving Knowledge Walls, ten obstacle
 * kinds in four tiers and server-planned orbs. Pure and deterministic — every hazard, wall motion and orb is a
 * closed-form function of the race clock and the course plan, so the authority ({@link RushCompetition}), the browser
 * mirror ({@code rushReforged.ts}) and the 3D world agree. Constants are compared with the TypeScript mirror by
 * {@code scripts/test-echo-quiz-rush.mjs}.
 *
 * Course version 7 ("Hardcore") plays on the same functions: no railing anywhere (every road edge is a real drop), harder
 * tiers 5–6, knocks that can throw a runner into the abyss, falls that keep their momentum, and four more obstacles — the
 * Wind Balance Bridge (BEAM), Floating Stepping Stones (STEPS), the Tilting Road (TILT) and the Spiked Rotating Rollers
 * (ROLLER). Tiers 5–6 and the new kinds exist only in version 7 plans, so a stored version 6 race plays exactly as before.
 *
 * Units as in version 5: x lateral (road centre 500), y forward, z height (x's scale); scene metres are x × .01,
 * y × .02, z × .01. Speeds are given in scene metres per second and converted per axis, so a diagonal is a true
 * diagonal on screen.
 */
public final class RushReforged {
    public static final int VERSION=6,HARDCORE=7;
    public static final double KX=RushTrials.KX,KY=RushTrials.KY,RS=RushTrials.RS;
    // Movement (scene m/s). 4.24 m/s = the version 5 base run (212 units/s); no input ⇒ no movement.
    public static final double MOVE=4.24,SPRINT=5.6,DASH=8.2,DASH_TIME=.25,RUSH=6.4,BACK=.62,ACCEL=11,BRAKE=13,AIR=2.6,SNARE=1.9;
    public static final double SPEED_ORB=1.25,SPEED_TIME=4,ENERGY_ORB=35,SHIELD_TIME=12,SHIELD_GUARD=.6,ORB_REACH=.65,BODY=90;
    public static final double STUMBLE_TIME=.42,RECOIL=260,BUMP=200,BUMP_SPEED=60;
    // Road: stone edge 470 units from the centre; on version 6 a railing keeps the runner's centre within 424 outside obstacle zones.
    public static final double EDGE=470,RAIL=424,GALE_HALF=220,RESPAWN_BACK=120;
    // Version 7: knocks hit harder, a fall keeps the runner's momentum (eased by air drag), a respawn stays on the road.
    public static final double KNOCK7_X=2.3,KNOCK7_Y=1.45,FALL_DRAG=1.4,RESPAWN_SIDE=250;
    // Segment: lead-in, hazard zone(s) with a 260 gap between two, run-out, then the reading approach to the wall.
    public static final double LEAD_IN=300,BETWEEN=260,RUNOUT=320,READ_BASE=760,READ_PER_WORD=30,READ_MIN=1100,READ_MAX=1750,WALL_ROOM=380;
    public static final List<String> KINDS=List.of("MILL","RAMS","BOULDERS","SKYFALL","CHASM","SAWS","CRUSHER","GALE","CRUMBLE","DRIFT");
    public static final List<String> KINDS7=List.of("MILL","RAMS","BOULDERS","SKYFALL","CHASM","SAWS","CRUSHER","GALE","CRUMBLE","DRIFT","BEAM","STEPS","TILT","ROLLER");
    public static final List<String> WALLS=List.of("STATIC","APPROACH","SLIDE","TIMED","RISING","SURGE");

    /**
     * One Knowledge Wall's motion. APPROACH / SURGE: the whole wall advances `travel` toward the runner (rest, advance,
     * hold, retreat — seconds), SLIDE / SURGE: every doorway slides by amp·sin; TIMED: crystal shutters close every
     * `shutPeriod` for the part after `openShare`. All doors move together, so motion never hints at an answer.
     */
    public record Wall(String kind,int tier,double phase,double travel,double rest,double advance,double hold,double retreat,
                       double amp,double slidePeriod,double shutPeriod,double openShare) {}
    public record Orb(int id,String kind,int checkpoint,double x,double y,double z) {}
    public record Plan(List<Double> boundaries,List<Hazard> hazards,List<Wall> walls,List<Orb> orbs) {}

    static double smooth(double u){u=Math.max(0,Math.min(1,u));return u*u*(3-2*u);}
    static double mod(double a,double n){double r=a%n;return r<0?r+n:r;}
    static double side(double v,double fallback){return v>0?1:v<0?-1:fallback;}

    /** The reading approach: with manual movement the player reads at their own pace, so this is room, not time. */
    public static double readingLength(RushQuestions.Pinned q){
        var text=new StringBuilder(q.prompt()).append(' ').append(q.context());for(var o:q.options())text.append(' ').append(o.label());
        int words=text.toString().trim().split("\\s+").length;return Math.max(READ_MIN,Math.min(READ_MAX,READ_BASE+READ_PER_WORD*words));
    }
    public static double length(String kind,int tier){
        return switch(kind){
            case "MILL","RAMS","BOULDERS","SKYFALL","CHASM"->RushTrials.length(kind,Math.min(3,tier))+(kind.equals("SKYFALL")&&tier>=4?300:0);
            case "SAWS"->360+(sawRows(tier)-1)*SAW_GAP;
            case "CRUSHER"->400+(crushRows(tier)-1)*CRUSH_GAP;
            case "GALE"->GALE_LENGTH;
            case "CRUMBLE"->crumbleTiles(tier)*CRUMBLE_TILE;
            case "DRIFT"->driftRows(tier)*DRIFT_GAP+100;
            case "BEAM"->BEAM_LEN[tier-1];
            case "STEPS"->2*STEP_EDGE+(stepRows(tier)-1)*STEP_GAP[tier-1];
            case "TILT"->TILT_LEN[tier-1];
            case "ROLLER"->ROLL_LEN[tier-1];
            default->0;
        };
    }

    // ───────────────────────────────── Plan ─────────────────────────────────
    static int tierAt(double p,int shift){int t=1+(p>=.25?1:0)+(p>=.55?1:0)+(p>=.8?1:0)+shift;return Math.max(1,Math.min(shift<0?3:4,t));}
    /** Version 7 intensity: rises through the race to 6 at the finish (Easy stops at 4, Hard starts at 3). */
    static int tier7(double p,String d){int base=p<.15?1:p<.4?2:p<.65?3:p<.85?4:5;return switch(d){case "EASY"->Math.min(4,base);case "HARD"->Math.min(6,base+2);default->Math.min(6,base+1);};}
    static List<String> unlocked(double p){
        if(p<.25)return List.of("CHASM","MILL","SAWS");
        if(p<.5)return List.of("CHASM","MILL","SAWS","RAMS","BOULDERS","CRUMBLE");
        if(p<.75)return List.of("CHASM","MILL","SAWS","RAMS","BOULDERS","CRUMBLE","SKYFALL","CRUSHER","GALE");
        return KINDS;
    }
    static List<String> unlocked7(double p){
        if(p<.2)return List.of("CHASM","MILL","SAWS","STEPS");
        if(p<.45)return List.of("CHASM","MILL","SAWS","STEPS","RAMS","BOULDERS","CRUMBLE","TILT","BEAM");
        if(p<.7)return List.of("CHASM","MILL","SAWS","STEPS","RAMS","BOULDERS","CRUMBLE","TILT","BEAM","SKYFALL","CRUSHER","GALE","DRIFT","ROLLER");
        return KINDS7;
    }
    /** The version 6 course (stored races and their tests). */
    public static Plan plan(List<RushQuestions.Pinned> questions,long seed,String difficulty){return plan(questions,seed,difficulty,VERSION);}
    /**
     * Course plan. Segment 1 is always clear; at most three hazard segments in a row; late segments may chain two
     * hazards; kinds unlock with progress from a shuffle bag; intensity (tier 1–4) grows toward the finish and with the
     * difficulty. Walls: static first, then approaching / sliding / timed / rising walls, and a demanding final Grand
     * Gate; never two rising walls in a row, never the same moving kind three times in a row. Version 7 delegates to
     * {@link #plan7}.
     */
    public static Plan plan(List<RushQuestions.Pinned> questions,long seed,String difficulty,int version){
        if(version>=HARDCORE)return plan7(questions,seed,difficulty);
        var random=new Random(seed^0x6E1F0C35L);int n=questions.size();String d=Objects.toString(difficulty,"MEDIUM");
        double density=switch(d){case "EASY"->.6;case "HARD"->.92;default->.8;};
        double chain=switch(d){case "EASY"->.15;case "HARD"->.5;default->.35;};
        int shift=switch(d){case "EASY"->-1;case "HARD"->1;default->0;};
        var boundaries=new ArrayList<Double>();var hazards=new ArrayList<Hazard>();var walls=new ArrayList<Wall>();var orbs=new ArrayList<Orb>();
        var bag=new ArrayList<String>();String previous="";int run=0,clear=0;double at=0;int guardAt=-9;
        for(int i=0;i<n;i++){
            double p=n<=1?1:(double)i/(n-1),start=at;var q=questions.get(i);
            boolean want=i>0&&run<3&&(clear>=2||random.nextDouble()<density||n<=3);
            var mine=new ArrayList<Hazard>();
            if(want){
                int count=p>=.6&&random.nextDouble()<chain?2:1;double from=at+LEAD_IN;
                for(int k=0;k<count;k++){
                    var open=unlocked(p);bag.removeIf(x->!open.contains(x));if(bag.isEmpty()){bag.addAll(open);Collections.shuffle(bag,random);}
                    int pick=0;while(pick<bag.size()-1&&bag.get(pick).equals(previous))pick++;String kind=bag.remove(pick);
                    int tier=tierAt(p,shift);if(k==1)tier=Math.max(1,tier-1);
                    var h=new Hazard(kind,i,from,from+length(kind,tier),tier,random.nextDouble()*Math.PI*2,random.nextBoolean()?1:-1,
                        kind.equals("CHASM")&&tier<3?random.nextInt(3):-1,random.nextInt(Integer.MAX_VALUE));
                    mine.add(h);previous=kind;from=h.to()+BETWEEN;
                }
                hazards.addAll(mine);run++;clear=0;at=mine.getLast().to()+RUNOUT;
            }else{run=0;if(i>0)clear++;}
            double reading=readingLength(q);at+=reading;boundaries.add(at);
            walls.add(wall(i,n,p,tierAt(p,shift),d,q.options().size(),reading,walls.isEmpty()?null:walls.getLast(),walls.size()>1?walls.get(walls.size()-2):null,random));
            // Orbs: one reward inside each hazard (reachable, never in an unavoidable spot) and sometimes one on the run-out.
            for(var h:mine){var o=orbFor(h,orbs.size(),random,i-guardAt>=3);if(o!=null){orbs.add(o);if(o.kind().equals("GUARD"))guardAt=i;}}
            if(i>0&&(mine.isEmpty()?random.nextDouble()<.55:random.nextDouble()<.4)){
                double y=mine.isEmpty()?start+LEAD_IN+random.nextDouble()*300:mine.getLast().to()+RUNOUT*.55;
                orbs.add(new Orb(orbs.size(),random.nextDouble()<.5?"ENERGY":"SPEED",i,RushTrials.LANES[random.nextInt(3)],y,BODY));
            }
        }
        return new Plan(List.copyOf(boundaries),List.copyOf(hazards),List.copyOf(walls),List.copyOf(orbs));
    }
    /**
     * Version 7 course. Denser hazards (Hard: every segment after the first) with at most four in a row (Easy three),
     * chains of two from earlier in the race, the 14-kind bag unlocking with progress, intensity rising to tier 6 at the
     * finish, and a signature finale: the last segment always ends with the Spiked Rotating Rollers (after a second
     * obstacle except on Easy). Two obstacles of a segment are always separated by plain road, so no combination is
     * forced to be unavoidable; the reading approach to every wall is kept whole.
     */
    static Plan plan7(List<RushQuestions.Pinned> questions,long seed,String difficulty){
        var random=new Random(seed^0x7B5D2E91L);int n=questions.size();String d=Objects.toString(difficulty,"MEDIUM");
        double density=switch(d){case "EASY"->.72;case "HARD"->1.0;default->.88;};
        double chain=switch(d){case "EASY"->.25;case "HARD"->.7;default->.5;};
        double chainFrom=switch(d){case "EASY"->.55;case "HARD"->.3;default->.4;};
        int maxRun=d.equals("EASY")?3:4;
        var boundaries=new ArrayList<Double>();var hazards=new ArrayList<Hazard>();var walls=new ArrayList<Wall>();var orbs=new ArrayList<Orb>();
        var bag=new ArrayList<String>();String previous="";int run=0,clear=0;double at=0;int guardAt=-9;
        for(int i=0;i<n;i++){
            double p=n<=1?1:(double)i/(n-1),start=at;var q=questions.get(i);
            boolean finale=i==n-1&&n>=3,want=finale||i>0&&run<maxRun&&(clear>=1||random.nextDouble()<density||n<=3);
            var mine=new ArrayList<Hazard>();
            if(want){
                int count=finale?(d.equals("EASY")?1:2):p>=chainFrom&&random.nextDouble()<chain?2:1;double from=at+LEAD_IN;
                for(int k=0;k<count;k++){
                    String kind;
                    if(finale&&k==count-1)kind="ROLLER";
                    else{
                        var open=unlocked7(p);bag.removeIf(x->!open.contains(x));if(bag.isEmpty()){bag.addAll(open);Collections.shuffle(bag,random);}
                        int pick=0;while(pick<bag.size()-1&&(bag.get(pick).equals(previous)||finale&&bag.get(pick).equals("ROLLER")))pick++;kind=bag.remove(pick);
                    }
                    // The finale's roller on Easy stays one step gentler (a pad between its logs, two pegs a ring).
                    int tier=tier7(p,d);if(k==1&&!finale)tier=Math.max(1,tier-1);if(finale&&kind.equals("ROLLER")&&d.equals("EASY"))tier=Math.min(tier,3);

                    var h=new Hazard(kind,i,from,from+length(kind,tier),tier,random.nextDouble()*Math.PI*2,random.nextBoolean()?1:-1,
                        kind.equals("CHASM")&&tier<3?random.nextInt(3):-1,random.nextInt(Integer.MAX_VALUE));
                    mine.add(h);previous=kind;from=h.to()+BETWEEN;
                }
                hazards.addAll(mine);run++;clear=0;at=mine.getLast().to()+RUNOUT;
            }else{run=0;if(i>0)clear++;}
            double reading=readingLength(q);at+=reading;boundaries.add(at);
            walls.add(wall(i,n,p,tier7(p,d),d,q.options().size(),reading,walls.isEmpty()?null:walls.getLast(),walls.size()>1?walls.get(walls.size()-2):null,random));
            for(var h:mine){var o=orbFor(h,orbs.size(),random,i-guardAt>=3);if(o!=null){orbs.add(o);if(o.kind().equals("GUARD"))guardAt=i;}}
            if(i>0&&(mine.isEmpty()?random.nextDouble()<.55:random.nextDouble()<.4)){
                double y=mine.isEmpty()?start+LEAD_IN+random.nextDouble()*300:mine.getLast().to()+RUNOUT*.55;
                orbs.add(new Orb(orbs.size(),random.nextDouble()<.5?"ENERGY":"SPEED",i,RushTrials.LANES[random.nextInt(3)],y,BODY));
            }
        }
        return new Plan(List.copyOf(boundaries),List.copyOf(hazards),List.copyOf(walls),List.copyOf(orbs));
    }
    static final double[] WALL_TRAVEL={420,560,700,820,900,960},WALL_SPEED={95,115,135,155,175,195},WALL_SLIDE={5.2,4.4,3.7,3.1,2.75,2.45},
        WALL_SHUT={3.8,3.4,3.0,2.7,2.5,2.3},WALL_OPEN={.62,.56,.5,.46,.44,.42};
    static Wall wall(int i,int n,double p,int tier,String d,int doors,double reading,Wall last,Wall before,Random random){
        boolean grand=i==n-1&&n>1;String kind;
        if(i==0)kind="STATIC";
        else if(grand)kind=d.equals("HARD")?"SURGE":d.equals("EASY")?"APPROACH":random.nextBoolean()?"SURGE":"APPROACH";
        else{
            double r=random.nextDouble();
            if(p<.3)kind=r<.45?"STATIC":r<.75?"APPROACH":"SLIDE";
            else if(p<.6)kind=r<.15?"STATIC":r<.45?"APPROACH":r<.65?"SLIDE":r<.85?"TIMED":"RISING";
            else kind=r<.3?(d.equals("EASY")?"APPROACH":"SURGE"):r<.5?"APPROACH":r<.7?"TIMED":r<.85?"RISING":"SLIDE";
        }
        if(kind.equals("RISING")&&last!=null&&last.kind().equals("RISING"))kind="APPROACH";
        if(last!=null&&before!=null&&!kind.equals("STATIC")&&kind.equals(last.kind())&&kind.equals(before.kind()))kind=kind.equals("APPROACH")?"SLIDE":"APPROACH";
        boolean approach=kind.equals("APPROACH")||kind.equals("SURGE"),slide=kind.equals("SLIDE")||kind.equals("SURGE"),timed=kind.equals("TIMED");
        double travel=approach?Math.min(reading-WALL_ROOM,WALL_TRAVEL[tier-1]):0;
        double speed=WALL_SPEED[tier-1];
        double advance=approach?travel*1.5/speed:0,retreat=approach?travel*1.5/260:0,rest=approach?3.2-.3*tier:0,hold=approach?1.2:0;
        double amp=slide?900.0/doors*.3:0,slidePeriod=slide?WALL_SLIDE[tier-1]:0;
        double shutPeriod=timed?WALL_SHUT[tier-1]:0,openShare=timed?WALL_OPEN[tier-1]:0;
        double cycle=Math.max(1,rest+advance+hold+retreat);
        return new Wall(kind,tier,random.nextDouble()*cycle,travel,rest,advance,hold,retreat,amp,slidePeriod,shutPeriod,openShare);
    }
    static Orb orbFor(Hazard h,int id,Random random,boolean guardAllowed){
        double r=random.nextDouble();String kind=guardAllowed&&r<.18?"GUARD":r<.6?"ENERGY":"SPEED";
        double lane=RushTrials.LANES[random.nextInt(3)],mid=(h.from()+h.to())/2;
        return switch(h.kind()){
            // Over the gap at jump height in a lane: collected only by a real leap across.
            case "CHASM"->new Orb(id,kind,h.checkpoint(),h.lane()>=0&&random.nextBoolean()?RushTrials.LANES[h.lane()]:lane,RushTrials.chasmCenter(h),BODY+72);
            case "DRIFT"->new Orb(id,kind,h.checkpoint(),500,driftY(h,driftRows(h.tier())/2),BODY+68);
            case "SAWS"->new Orb(id,kind,h.checkpoint(),lane,sawY(h,0)+SAW_GAP/2,BODY);
            case "CRUSHER"->new Orb(id,kind,h.checkpoint(),500,crushY(h,0)+CRUSH_GAP/2,BODY);
            case "GALE"->new Orb(id,kind,h.checkpoint(),500+(random.nextBoolean()?1:-1)*140,mid,BODY);
            case "CRUMBLE"->new Orb(id,kind,h.checkpoint(),lane,mid,BODY+20);
            case "MILL"->new Orb(id,kind,h.checkpoint(),500+(random.nextBoolean()?1:-1)*260,RushTrials.millCenter(h),BODY);
            case "RAMS"->new Orb(id,kind,h.checkpoint(),lane,RushTrials.ramY(h,1)+RushTrials.RAM_GAP/2,BODY);
            // Version 7: above a middle stepping stone (a hop takes it), on the beam, on the uphill side of the lean, over a roller.
            case "STEPS"->new Orb(id,kind,h.checkpoint(),stepX(h,stepRows(h.tier())/2),stepY(h,stepRows(h.tier())/2),BODY+68);
            case "BEAM"->new Orb(id,kind,h.checkpoint(),500,mid,BODY);
            case "TILT"->new Orb(id,kind,h.checkpoint(),500-tiltSign(h,0)*160,h.from()+TILT_SEG/2,BODY);
            case "ROLLER"->new Orb(id,kind,h.checkpoint(),logX(h,0),(logFrom(h,0)+logTo(h,0))/2,BODY+68);
            default->new Orb(id,kind,h.checkpoint(),lane,h.from()+(h.to()-h.from())*.45,BODY);
        };
    }
    public static List<Hazard> hazards(List<Hazard> all,int checkpoint){if(all==null)return List.of();var out=new ArrayList<Hazard>(2);for(var h:all)if(h.checkpoint()==checkpoint)out.add(h);return out;}
    public static Wall wall(List<Wall> walls,int checkpoint){return walls==null||checkpoint<0||checkpoint>=walls.size()?null:walls.get(checkpoint);}

    // ───────────────────────────────── Walls ─────────────────────────────────
    public static double cycle(Wall w){return w.rest()+w.advance()+w.hold()+w.retreat();}
    /** How far the wall has advanced toward the runner (units, ≥ 0). */
    public static double approach(Wall w,double t){
        if(w==null||w.travel()<=0)return 0;double u=mod(t-w.phase(),cycle(w));
        if(u<w.rest())return 0;u-=w.rest();if(u<w.advance())return w.travel()*smooth(u/w.advance());u-=w.advance();
        if(u<w.hold())return w.travel();u-=w.hold();return w.travel()*(1-smooth(u/w.retreat()));
    }
    /** Lateral offset of every doorway (units). */
    public static double slide(Wall w,double t){return w==null||w.amp()<=0?0:w.amp()*Math.sin(2*Math.PI*(t-w.phase())/w.slidePeriod());}
    /** True while the crystal shutters block every doorway (a door the runner opened stays open). */
    public static boolean shut(Wall w,double t){return w!=null&&w.shutPeriod()>0&&mod(t-w.phase(),w.shutPeriod())/w.shutPeriod()>=w.openShare();}
    /** 0 → shutters fully up, 1 → fully down; drawn ahead of the collision (a falling shutter still lets you through). */
    public static double shutter(Wall w,double t){
        if(w==null||w.shutPeriod()<=0)return 0;double u=mod(t-w.phase(),w.shutPeriod())/w.shutPeriod(),lead=.2/w.shutPeriod();
        if(u<w.openShare()-lead)return 0;if(u<w.openShare())return (u-(w.openShare()-lead))/lead;if(u<1-lead)return 1;return 1-(u-(1-lead))/lead;
    }
    /** The wall plane for a checkpoint whose resting position is `rest`. */
    public static double plane(Wall w,double rest,double t){return rest-approach(w,t);}

    // ───────────────────────────────── Road edges ─────────────────────────────────
    /** The hazard zone containing y (open edges there), or null where the road is plain. */
    public static Hazard zone(List<Hazard> hazards,double y){for(var h:hazards)if(y>=h.from()&&y<=h.to())return h;return null;}
    /** Version 6: open half-width at y (−1 = railed). Version 7 has no railing at all. */
    public static double openHalf(List<Hazard> hazards,double y){var h=zone(hazards,y);return h==null?-1:h.kind().equals("GALE")?galeHalf(h):EDGE;}

    // ───────────────────────────────── New hazards ─────────────────────────────────
    // Rune Saws: spinning blades running in floor slots across the road; opposing pairs on harder tiers; on tiers 5–6 the
    // rows alternate their sweep direction. Time the pass.
    public static final double SAW_GAP=300,SAW_R=.6,SAW_C=.35,SAW_HALF_Y=.1,SAW_AMP=380;
    public static final double[] SAW_SPIN={1.5,1.9,2.4,2.9,3.3,3.7};
    public static int sawRows(int tier){return tier<=2?2:tier>=5?4:3;}
    public static double sawY(Hazard h,int j){return h.from()+180+j*SAW_GAP;}
    public static boolean sawDouble(Hazard h,int j){return h.tier()>=3||h.tier()==2&&j%2==1;}
    public static int sawRowDir(Hazard h,int j){return h.tier()>=5&&j%2==1?-1:1;}
    public static double sawAngle(Hazard h,int j,double t){return h.phase()+j*1.7+sawRowDir(h,j)*SAW_SPIN[h.tier()-1]*t;}
    /** x of blade b (0, or 1 for the opposing blade) of row j. */
    public static double sawX(Hazard h,int j,int b,double t){double s=Math.sin(sawAngle(h,j,t))*h.dir();return 500+(b==0?s:-s)*SAW_AMP;}
    public static double sawVx(Hazard h,int j,int b,double t){double v=Math.cos(sawAngle(h,j,t))*h.dir()*sawRowDir(h,j)*SAW_SPIN[h.tier()-1]*SAW_AMP;return b==0?v:-v;}
    static Hit saws(Hazard h,double t,double x,double y,double z){
        if(z*KX>=SAW_C+SAW_R-.1)return null;
        for(int j=0;j<sawRows(h.tier());j++){
            if(Math.abs((y-sawY(h,j))*KY)>SAW_HALF_Y+RS)continue;
            for(int b=0;b<(sawDouble(h,j)?2:1);b++)if(Math.abs((x-sawX(h,j,b,t))*KX)<=SAW_R+RS*.6)return new Hit(side(sawVx(h,j,b,t),side(x-sawX(h,j,b,t),1))*360,-240);
        }
        return null;
    }

    // Crushing Walls: stone blocks slam in from both edges and meet in the middle; pass while they are open. On tiers 5–6
    // every second row is a one-sided ram that drives most of the way across and shoves a runner toward the far edge.
    public static final double CRUSH_GAP=320,CRUSH_HALF_Y=.9,CRUSH_REACH=770;
    public static final double[] CRUSH_PERIOD={3.6,3.2,2.85,2.5,2.25,2.0};
    public static int crushRows(int tier){return tier<=2?2:tier>=5?4:3;}
    public static double crushY(Hazard h,int j){return h.from()+200+j*CRUSH_GAP;}
    public static boolean crushOneSided(Hazard h,int j){return h.tier()>=5&&j%2==1;}
    /** The side (−1 left, +1 right) a one-sided ram drives from. */
    public static int crushSide(Hazard h,int j){return (j/2)%2==0?h.dir():-h.dir();}
    /** Closure 0 (open) → 1 (blocks meet) of row j: open, a fast slam, held shut, a slow retract. */
    public static double closure(Hazard h,int j,double t){
        double period=CRUSH_PERIOD[h.tier()-1],u=mod(t-h.phase()/(2*Math.PI)*period-j*.33*period,period)/period;
        if(u<.45)return 0;if(u<.55)return smooth((u-.45)/.1);if(u<.7)return 1;return 1-(u-.7)/.3;
    }
    static Hit crusher(Hazard h,double t,double x,double y){
        for(int j=0;j<crushRows(h.tier());j++){
            if(Math.abs((y-crushY(h,j))*KY)>CRUSH_HALF_Y+RS)continue;
            double c=closure(h,j,t);if(c<=.04)continue;
            if(crushOneSided(h,j)){int s=crushSide(h,j);if(s*(x-500)+RS/KX>=EDGE-CRUSH_REACH*c)return new Hit(-s*520,-150);}
            else if(Math.abs(x-500)*KX+RS>=EDGE*KX*(1-c))return new Hit(0,-330);
        }
        return null;
    }

    // Gale Bridge: a narrow span with open edges; gusts push across it. Lean into the wind.
    public static final double GALE_LENGTH=900;
    public static final double[] GALE_PERIOD={3.6,3.3,3.0,2.7,2.45,2.2},GALE_FORCE={150,190,230,270,310,350};
    public static double galeHalf(Hazard h){return h.tier()>=6?170:h.tier()==5?190:GALE_HALF;}
    // Wind Balance Bridge (version 7): a much narrower beam over the void, longer, with telegraphed gusts. Counter-steer.
    public static final double[] BEAM_LEN={800,900,1000,1100,1200,1300},BEAM_HALF={130,120,110,100,92,85},BEAM_PERIOD={3.4,3.1,2.8,2.5,2.3,2.1},BEAM_FORCE={160,195,230,255,265,270};
    static boolean windy(Hazard h){return h!=null&&(h.kind().equals("GALE")||h.kind().equals("BEAM"));}
    public static double gustPeriod(Hazard h){return (h.kind().equals("BEAM")?BEAM_PERIOD:GALE_PERIOD)[h.tier()-1];}
    /** Gust direction of cycle n (seeded, both sides). */
    public static int gustDir(Hazard h,int n){return (RushTrials.mix(h.salt()+n*0x2545F491)&1)==0?1:-1;}
    public static int gustCycle(Hazard h,double t){return (int)Math.floor((t-h.phase())/gustPeriod(h));}
    /** Strength 0..1 of the gust: a warning (streaks) .03–.25, the push .25–.7 of each cycle. */
    public static double gust(Hazard h,double t){
        double period=gustPeriod(h),u=mod(t-h.phase(),period)/period;
        if(u<.25||u>.7)return 0;if(u<.32)return (u-.25)/.07;if(u<.64)return 1;return 1-(u-.64)/.06;
    }
    public static boolean gustWarning(Hazard h,double t){double period=gustPeriod(h),u=mod(t-h.phase(),period)/period;return u>=.03&&u<.25;}
    /** Lateral push (units/s) at time t inside the zone. */
    public static double wind(Hazard h,double t){return !windy(h)?0:gust(h,t)*(h.kind().equals("BEAM")?BEAM_FORCE:GALE_FORCE)[h.tier()-1]*gustDir(h,gustCycle(h,t));}

    // Crumbling Span: crystal tiles fall in a wave that travels away from the runner a little faster than a run; follow it.
    public static final double CRUMBLE_TILE=130,CRUMBLE_DOWN=.34,CRUMBLE_WARN=.14,CRUMBLE_TILE_TIME=.584;
    public static final double[] CRUMBLE_PERIOD={3.8,3.5,3.2,3.0,2.8,2.6};
    public static int crumbleTiles(int tier){return tier<=2?5:tier>=5?7:6;}
    public static double crumbleU(Hazard h,int k,double t){double period=CRUMBLE_PERIOD[h.tier()-1];return mod((t-h.phase()/(2*Math.PI)*period-k*CRUMBLE_TILE_TIME)/period,1);}
    public static boolean tileDown(Hazard h,int k,double t){return crumbleU(h,k,t)<CRUMBLE_DOWN;}
    /** 0..1 shake before a tile falls (warning), 0 otherwise. */
    public static double tileShake(Hazard h,int k,double t){double u=crumbleU(h,k,t);return u>=1-CRUMBLE_WARN?(u-(1-CRUMBLE_WARN))/CRUMBLE_WARN:0;}
    static boolean crumbleFalls(Hazard h,double y,double t){int k=(int)Math.floor((y-h.from())/CRUMBLE_TILE);return k>=0&&k<crumbleTiles(h.tier())&&tileDown(h,k,t);}

    // Drifting Stones: a void crossed on floating rune stones that sway sideways; leap from stone to stone (they carry you).
    public static final double DRIFT_GAP=125,DRIFT_R=.95;
    public static final double[] DRIFT_AMP={150,200,250,300,330,360},DRIFT_SPIN={.8,1.0,1.15,1.3,1.45,1.6};
    public static int driftRows(int tier){return new int[]{3,4,4,5,5,6}[tier-1];}
    public static double driftY(Hazard h,int j){return h.from()+50+DRIFT_GAP/2+j*DRIFT_GAP;}
    public static double driftX(Hazard h,int j,double t){return 500+DRIFT_AMP[h.tier()-1]*Math.sin(DRIFT_SPIN[h.tier()-1]*t+h.phase()+j*2.1)*(j%2==0?h.dir():-h.dir());}
    public static double driftVx(Hazard h,int j,double t){return DRIFT_AMP[h.tier()-1]*DRIFT_SPIN[h.tier()-1]*Math.cos(DRIFT_SPIN[h.tier()-1]*t+h.phase()+j*2.1)*(j%2==0?h.dir():-h.dir());}
    /** The stone carrying a grounded runner at (x, y), or −1 over the void. */
    public static int stoneUnder(Hazard h,double x,double y,double t){
        for(int j=0;j<driftRows(h.tier());j++){double dx=(x-driftX(h,j,t))*KX,dy=(y-driftY(h,j))*KY;if(dx*dx+dy*dy<=DRIFT_R*DRIFT_R)return j;}
        return -1;
    }

    // Floating Stepping Stones (version 7): rune stones stand apart over the void in a zigzag; leap from stone to stone.
    // From tier 3 every second stone dips for a moment (it shakes first): it sinks slightly and its footing shrinks to
    // STEP_DIP of its radius — never gone, so a crossing always remains. Spacing calibrated against a plain hop rhythm.
    public static final double STEP_EDGE=100,STEP_DOWN=.28,STEP_WARN=.18,STEP_DIP=.6;
    public static final double[] STEP_GAP={156,152,146,140,136,132},STEP_OFF={40,52,62,72,80,88},STEP_R={1.15,1.1,1.05,1.0,.95,.9},STEP_SINK={0,0,4.2,3.8,3.4,3.0};
    public static int stepRows(int tier){return new int[]{4,4,5,5,6,6}[tier-1];}
    public static double stepY(Hazard h,int j){return h.from()+STEP_EDGE+j*STEP_GAP[h.tier()-1];}
    public static double stepX(Hazard h,int j){
        double jitter=h.tier()>=4?Math.floorMod(RushTrials.mix(h.salt()+j*0x632BE5AB),61)-30:0;
        return 500+(j%2==0?1:-1)*h.dir()*STEP_OFF[h.tier()-1]+jitter;
    }
    public static boolean stepSinks(Hazard h,int j){return h.tier()>=3&&j%2==1;}
    public static double stepU(Hazard h,int j,double t){double period=STEP_SINK[h.tier()-1];return mod(t-h.phase()/(2*Math.PI)*period-j*.9,period)/period;}
    public static boolean stepDown(Hazard h,int j,double t){return stepSinks(h,j)&&stepU(h,j,t)<STEP_DOWN;}
    /** 0..1 shake before a sinking stone drops (warning), 0 otherwise. */
    public static double stepShake(Hazard h,int j,double t){if(!stepSinks(h,j))return 0;double u=stepU(h,j,t);return u>=1-STEP_WARN?(u-(1-STEP_WARN))/STEP_WARN:0;}
    /** The stepping stone under a grounded runner at (x, y), or −1 over the void (a dipped stone's footing is smaller). */
    public static int stepUnder(Hazard h,double x,double y,double t){
        double r=STEP_R[h.tier()-1];
        for(int j=0;j<stepRows(h.tier());j++){double rr=stepDown(h,j,t)?r*STEP_DIP:r,dx=(x-stepX(h,j))*KX,dy=(y-stepY(h,j))*KY;if(dx*dx+dy*dy<=rr*rr)return j;}
        return -1;
    }

    // Tilting Road (version 7): the deck leans hard to one side in 6 m sections (alternating from tier 3), eased across
    // every joint; a grounded runner slides toward the low edge unless they steer uphill.
    public static final double TILT_SEG=300,TILT_BLEND=70;
    public static final double[] TILT_LEN={700,800,900,1000,1100,1200},TILT_DEG={12,15,17,19,21,23},TILT_PULL={150,180,210,240,265,290};
    static int tiltSign(Hazard h,int k){return h.tier()>=3&&k%2==1?-h.dir():h.dir();}
    /** Signed lean (radians; + means the +x side is low) at y. */
    public static double tiltAngle(Hazard h,double y){
        double u=y-h.from();if(u<0||y>h.to())return 0;double a=Math.toRadians(TILT_DEG[h.tier()-1]);
        int k=(int)Math.floor(u/TILT_SEG);double within=u-k*TILT_SEG,cur=tiltSign(h,k)*a,prev=k==0?0:tiltSign(h,k-1)*a;
        double v=within<TILT_BLEND?prev+(cur-prev)*smooth(within/TILT_BLEND):cur,end=h.to()-y;
        return end<TILT_BLEND?v*smooth(end/TILT_BLEND):v;
    }
    /** The leaning deck's horizontal half-width (the drawn deck keeps its width along the slope). */
    public static double tiltHalf(Hazard h,double y){return EDGE*Math.cos(tiltAngle(h,y));}
    /** Grounded slide toward the low edge (units/s). */
    public static double tiltSlide(Hazard h,double y){return TILT_PULL[h.tier()-1]*Math.sin(tiltAngle(h,y))/Math.sin(Math.toRadians(TILT_DEG[h.tier()-1]));}

    // Spiked Rotating Rollers (version 7): long logs span the abyss and spin about their length, studded with short pegs
    // in staggered rings. Run along the top against the turning surface, and hop or time every passing peg. Tier 1: one
    // central log; 2: two parallel logs turning opposite ways (pick one); 3–4: two logs in sequence with a stone pad
    // between; 5–6: two logs in sequence with a short void to leap.
    public static final double ROLL_R=.55,ROLL_PEG=.42,ROLL_PEG_HALF=.07,ROLL_SUPPORT=.46,ROLL_BODY=.24,ROLL_PAD=70,ROLL_PAD_HALF=120,ROLL_JUMP=50,ROLL_SIDE=160;
    public static final double[] ROLL_LEN={620,680,760,800,840,880},ROLL_SPIN={1.15,1.4,1.6,1.8,2.0,2.2},ROLL_RING={80,74,70,66,62,66};
    public static final int[] ROLL_PEGS={1,2,2,2,2,2};
    static final double[] PEG_SAMPLES={.15,.5,.85,1};
    public static int logCount(Hazard h){return h.tier()==1?1:2;}
    static boolean parallel(Hazard h){return h.tier()==2;}
    public static double logX(Hazard h,int i){return parallel(h)?500+(i==0?-ROLL_SIDE:ROLL_SIDE):500;}
    /** Tiers 3–4 have a stone pad between the two logs; tiers 5–6 a short void to leap. */
    public static boolean rollerPad(Hazard h){return h.tier()==3||h.tier()==4;}
    public static double logFrom(Hazard h,int i){return parallel(h)||h.tier()==1||i==0?h.from():(h.from()+h.to())/2+(rollerPad(h)?ROLL_PAD:ROLL_JUMP)/2;}
    public static double logTo(Hazard h,int i){return parallel(h)||h.tier()==1||i==1?h.to():(h.from()+h.to())/2-(rollerPad(h)?ROLL_PAD:ROLL_JUMP)/2;}
    /** +1: the top of the log moves toward +x. Neighbouring logs always turn opposite ways. */
    public static int logDir(Hazard h,int i){return i==0?h.dir():-h.dir();}
    public static int ringCount(Hazard h,int i){return Math.max(1,(int)Math.floor((logTo(h,i)-logFrom(h,i)-40)/ROLL_RING[h.tier()-1]));}
    public static double ringY(Hazard h,int i,int j){return logFrom(h,i)+(logTo(h,i)-logFrom(h,i))*(j+.5)/ringCount(h,i);}
    public static int pegsIn(Hazard h,int j){return h.tier()==6&&j%2==1?3:ROLL_PEGS[h.tier()-1];}
    /** Angle from the top (radians; + toward +x) of peg k of ring j on log i at time t. */
    public static double pegAngle(Hazard h,int i,int j,int k,double t){return h.phase()+i*1.3+j*2.39996+k*2*Math.PI/pegsIn(h,j)+logDir(h,i)*ROLL_SPIN[h.tier()-1]*t;}
    /** True when a grounded runner at (x, y) stands on a log (or the pad between two logs). */
    public static boolean rollerSupport(Hazard h,double x,double y){
        for(int i=0;i<logCount(h);i++)if(y>=logFrom(h,i)&&y<=logTo(h,i)&&Math.abs(x-logX(h,i))*KX<=ROLL_SUPPORT)return true;
        return rollerPad(h)&&Math.abs(y-(h.from()+h.to())/2)<=ROLL_PAD/2&&Math.abs(x-500)<=ROLL_PAD_HALF;
    }
    /** Lateral carry of the turning surface under a grounded runner (units/s). */
    public static double rollerCarry(Hazard h,double x,double y){
        for(int i=0;i<logCount(h);i++)if(y>=logFrom(h,i)&&y<=logTo(h,i)&&Math.abs(x-logX(h,i))*KX<=ROLL_SUPPORT)return logDir(h,i)*ROLL_SPIN[h.tier()-1]*ROLL_R/KX;
        return 0;
    }
    /** A peg meeting the runner's body (a narrow upright box from its feet up): the peg's sweep throws it sideways. */
    static Hit roller(Hazard h,double t,double x,double y,double z){
        for(int i=0;i<logCount(h);i++){
            double from=logFrom(h,i),to=logTo(h,i);if(y<from-20||y>to+20)continue;
            double dx=(x-logX(h,i))*KX,feet=z*KX;if(Math.abs(dx)>ROLL_R+ROLL_PEG+ROLL_BODY)continue;
            int n=ringCount(h,i),jc=(int)Math.round((y-from)/(to-from)*n-.5);
            for(int j=Math.max(0,jc-1);j<=Math.min(n-1,jc+1);j++){
                if(Math.abs((y-ringY(h,i,j))*KY)>ROLL_PEG_HALF+ROLL_BODY)continue;
                for(int k=0;k<pegsIn(h,j);k++){
                    double a=pegAngle(h,i,j,k,t),s=Math.sin(a),c=Math.cos(a);
                    for(double f:PEG_SAMPLES){double r=ROLL_R+ROLL_PEG*f,px=r*s,py=r*c-ROLL_R;
                        if(Math.abs(px-dx)<=ROLL_BODY+ROLL_PEG_HALF&&py>=feet-ROLL_PEG_HALF&&py<=feet+RushTrials.RUNNER_HEIGHT)return new Hit(side(logDir(h,i)*c,side(dx-px,1))*420,-120);}
                }
            }
        }
        return null;
    }

    // ───────────────────────────────── Dispatch ─────────────────────────────────
    /** A collision with any moving hazard of the zone, or null (falls are {@link #falls}). */
    public static Hit hit(Hazard h,double t,double x,double y,double z){
        if(h==null||y<h.from()-120||y>h.to()+120)return null;
        return switch(h.kind()){
            case "SAWS"->saws(h,t,x,y,z);case "CRUSHER"->crusher(h,t,x,y);case "ROLLER"->roller(h,t,x,y,z);
            case "MILL","RAMS","BOULDERS","SKYFALL"->RushTrials.hit(h,t,x,y,z);default->null;
        };
    }
    /** Version 6: a grounded runner at (x, y) has nothing under them: a gap, a fallen tile, the void between stones, or past an open edge. */
    public static boolean falls(List<Hazard> hazards,double x,double y,double t){return falls(hazards,x,y,t,false);}
    /** `open` (version 7): there is no railing, so outside obstacle zones the road edge is a real drop too. */
    public static boolean falls(List<Hazard> hazards,double x,double y,double t,boolean open){
        var h=zone(hazards,y);if(h==null)return open&&Math.abs(x-500)>EDGE;
        double dx=Math.abs(x-500);
        return switch(h.kind()){
            case "GALE"->dx>galeHalf(h);
            case "BEAM"->dx>BEAM_HALF[h.tier()-1];
            case "TILT"->dx>tiltHalf(h,y);
            case "STEPS"->stepUnder(h,x,y,t)<0;
            case "ROLLER"->!rollerSupport(h,x,y);
            case "CHASM"->dx>EDGE||RushTrials.falls(h,x,y);case "CRUMBLE"->dx>EDGE||crumbleFalls(h,y,t);
            case "DRIFT"->dx>EDGE||stoneUnder(h,x,y,t)<0;
            default->dx>EDGE;
        };
    }
    /** Where a fallen runner comes back: before the zone they fell in, on the safe lane of a broken bridge. */
    public static double respawnY(Hazard h){return h.kind().equals("CHASM")?RushTrials.respawnY(h):h.from()-RESPAWN_BACK;}
    public static double respawnX(Hazard h){return h.kind().equals("CHASM")&&h.lane()>=0?RushTrials.LANES[h.lane()]:500;}
    /**
     * Version 7: where a runner who fell at (x, y) comes back — before the obstacle zone they fell from, or (off a plain
     * edge) a little behind the fall, drawn in from the edge and never inside the end of an obstacle zone behind.
     */
    public static double[] respawnAt(List<Hazard> hazards,double x,double y){
        var h=zone(hazards,y);if(h!=null)return new double[]{respawnX(h),respawnY(h)};
        double back=y-RESPAWN_BACK;var behind=zone(hazards,back);
        return new double[]{500+Math.max(-RESPAWN_SIDE,Math.min(RESPAWN_SIDE,x-500)),behind!=null?behind.to()+30:back};
    }
    /** Lateral carry while standing (stone sway, the lean of the road, a turning roller) plus wind; units/s. */
    public static double drift(List<Hazard> hazards,double x,double y,double t,boolean grounded){
        var h=zone(hazards,y);if(h==null)return 0;
        if(windy(h))return wind(h,t);
        if(!grounded)return 0;
        return switch(h.kind()){
            case "DRIFT"->{int j=stoneUnder(h,x,y,t);yield j<0?0:driftVx(h,j,t);}
            case "TILT"->tiltSlide(h,y);
            case "ROLLER"->rollerCarry(h,x,y);
            default->0;
        };
    }
    /** Mill pillar slide (solid crystal column) for the zone at y. */
    public static double pillar(List<Hazard> hazards,double x,double y){for(var h:hazards)if(h.kind().equals("MILL"))x=RushTrials.millPillar(h,x,y);return x;}
    /**
     * Footholds a careful runner aims for at y (Echo Bots and test pilots only): the logs of a roller, the next stepping
     * stones, the middle of a beam, the uphill side of a lean. Empty on ordinary road.
     */
    public static double[] footholds(List<Hazard> hazards,double y){
        Hazard h=zone(hazards,y);if(h==null)for(var c:hazards)if(c.from()>y&&c.from()-y<320){h=c;break;}
        if(h==null)return new double[0];
        return switch(h.kind()){
            case "ROLLER"->logCount(h)==2&&parallel(h)?new double[]{logX(h,0),logX(h,1)}:new double[]{500};
            case "STEPS"->{int j=0;while(j<stepRows(h.tier())-1&&stepY(h,j)<y+20)j++;yield new double[]{stepX(h,j),stepX(h,Math.max(0,j-1))};}
            case "BEAM","GALE"->new double[]{500};
            case "TILT"->new double[]{500-Math.signum(tiltAngle(h,Math.max(h.from()+1,y)))*170};
            default->new double[0];
        };
    }
    /**
     * A careful stone-hopper (Echo Bots and test pilots only), for stepping and drifting stones: aim at the next stone
     * (where a drifting one will be on landing), run, leap when it lies about one jump ahead (or when the stone under the
     * feet is about to end), and in the air ease off the run if the landing would overshoot. Returns {targetX, forward, leap}.
     */
    public static double[] hopPilot(List<Hazard> hazards,double t,double x,double y,double z,double vx,double vy,double vz){
        Hazard h=zone(hazards,y);if(h==null)for(var c:hazards)if(c.from()>y&&c.from()-y<320){h=c;break;}
        if(h==null||!(h.kind().equals("STEPS")||h.kind().equals("DRIFT")))return new double[]{x,1,0};
        boolean steps=h.kind().equals("STEPS");int rows=steps?stepRows(h.tier()):driftRows(h.tier());double r=(steps?STEP_R[h.tier()-1]:DRIFT_R)/KY;
        boolean air=z>0||vz>0;double flight=2*RushTrials.JUMP_SPEED/RushTrials.GRAVITY;
        double land=air?(vz+Math.sqrt(vz*vz+2*RushTrials.GRAVITY*Math.max(0,z)))/RushTrials.GRAVITY:flight;
        int j=0;while(j<rows-1&&(steps?stepY(h,j):driftY(h,j))<y+r*.4)j++;
        double sy=steps?stepY(h,j):driftY(h,j),sx=steps?stepX(h,j):driftX(h,j,t+land);
        if(sy<y-r)return new double[]{500,1,0}; // past the last stone: on to the road
        // In the air: ease off if the landing would pass the stone's middle (a stepping stone: its near half, so the landing
        // recovery still ends on it; drifting stones sit closer together).
        if(air)return new double[]{sx,y+vy*land>sy+(steps?-.15:.25)*r?0:1,0};
        double reach=Math.max(vy,0)*flight;int under=-1;
        for(int k=0;k<rows;k++){double ky=steps?stepY(h,k):driftY(h,k);if(Math.abs(ky-y)<=r)under=k;}
        double ahead=under<0?Double.POSITIVE_INFINITY:(steps?stepY(h,under):driftY(h,under))+r*.8-y;
        boolean leap=y>=h.from()-60&&(sy-y<=reach+r*.3||ahead<Math.max(vy,0)*.06);
        return new double[]{sx,1,leap?1:0};
    }
    /** True where the way on is a chain of leaps (stepping or drifting stones) at or just ahead of y (bots and pilots). */
    public static boolean hopping(List<Hazard> hazards,double y){
        Hazard h=zone(hazards,y);if(h==null)for(var c:hazards)if(c.from()>y&&c.from()-y<320){h=c;break;}
        return h!=null&&(h.kind().equals("STEPS")||h.kind().equals("DRIFT"));
    }

    // ───────────────────────────────── Orbs ─────────────────────────────────
    /** True when the runner's body (centre BODY above its feet) touches the orb. */
    public static boolean touches(Orb o,double x,double y,double z){
        double dx=(x-o.x())*KX,dy=(y-o.y())*KY,dz=(z+BODY-o.z())*KX;return dx*dx+dy*dy+dz*dz<=ORB_REACH*ORB_REACH;
    }

    // ───────────────────────────────── Bots ─────────────────────────────────
    /**
     * Earliest predicted setback (seconds, +∞ if none within `horizon`) for a runner at (x, y, z) with velocity
     * (vx, vy, vz) holding forward input `forward` and steering toward xTarget, optionally leaping now. The prediction
     * uses the authority's own acceleration, air control, gravity, wind, stone carry and hazard functions — a move is
     * judged by what the body can really do (a runner who stopped at a gap cannot leap it from a standstill). Used only
     * by Echo Bots and test pilots.
     */
    public static double threat(List<Hazard> hazards,double t,double x,double y,double z,double vx,double vy,double vz,double xTarget,double forward,boolean leap,double horizon){
        return threat(hazards,t,x,y,z,vx,vy,vz,xTarget,forward,leap?0:-1,horizon,false);
    }
    /** As above with a planned leap `leapAt` seconds from now (−1: no leap). */
    public static double threat(List<Hazard> hazards,double t,double x,double y,double z,double vx,double vy,double vz,double xTarget,double forward,double leapAt,double horizon){
        return threat(hazards,t,x,y,z,vx,vy,vz,xTarget,forward,leapAt,horizon,false);
    }
    /** `open`: version 7 edges (a drop everywhere off the road). Steering is proportional near a narrow foothold. */
    public static double threat(List<Hazard> hazards,double t,double x,double y,double z,double vx,double vy,double vz,double xTarget,double forward,double leapAt,double horizon,boolean open){
        return threat(hazards,t,x,y,z,vx,vy,vz,xTarget,forward,leapAt,horizon,open,false);
    }
    /** `chain`: after the planned leap, leap again at every landing (as soon as a landing allows) — stone-to-stone hopping. */
    public static double threat(List<Hazard> hazards,double t,double x,double y,double z,double vx,double vy,double vz,double xTarget,double forward,double leapAt,double horizon,boolean open,boolean chain){
        return threat(hazards,t,x,y,z,vx,vy,vz,xTarget,forward,leapAt,horizon,open,chain,1);
    }
    /** `scale`: the runner's own speed factor (earned momentum, a speed orb) — a faster runner reaches a peg or a stone sooner. */
    public static double threat(List<Hazard> hazards,double t,double x,double y,double z,double vx,double vy,double vz,double xTarget,double forward,double leapAt,double horizon,boolean open,boolean chain,double scale){
        double step=.05,landed=-1,mv=MOVE*scale;boolean leapt=false;
        for(double tau=0;tau<=horizon+1e-9;tau+=step){
            if(leapAt>=0&&z<=0&&vz<=0&&(Math.abs(tau-leapAt)<step/2||chain&&leapt&&landed>=0&&tau-landed>=RushTrials.JUMP_RECOVER-1e-9)){vz=RushTrials.JUMP_SPEED;leapt=true;landed=-1;}
            if(tau>0){
                boolean air=z>0||vz>0;double dx=xTarget-x,h=open?Math.max(-1,Math.min(1,dx/40)):Math.abs(dx)>8?Math.signum(dx):0,f=forward,len=Math.hypot(h,f);if(len>1){h/=len;f/=len;}
                double k=Math.min(1,step*(air?AIR:len>.05?ACCEL:BRAKE));
                vx+=(h*mv/KX-vx)*k;vy+=(f*mv*(f<0?BACK:1)/KY-vy)*k;
                x+=(vx+drift(hazards,x,y,t+tau,!air))*step;y+=vy*step;
                if(air){z+=vz*step;vz-=RushTrials.GRAVITY*step;if(z<0){z=0;vz=0;landed=tau;}}
                x=pillar(hazards,x,y);
            }
            if(z<=0&&falls(hazards,x,y,t+tau,open))return tau;
            for(var h:hazards)if(hit(h,t+tau,x,y,z)!=null)return tau;
        }
        return Double.POSITIVE_INFINITY;
    }
    private RushReforged(){}
}
