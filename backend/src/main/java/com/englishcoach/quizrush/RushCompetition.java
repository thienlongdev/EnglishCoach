package com.englishcoach.quizrush;

import java.util.*;
import static com.englishcoach.quizrush.RushQuestions.Pinned;

/** Pure deterministic authority. No client positions, clocks, correctness or winners. */
public final class RushCompetition {
    public static final double STEP=1.0/120, SPACING=1100, RADIUS=26, BASE_SPEED=153, FINISH_OFFSET=700;
    /** Course version 4 (Skybound): per-checkpoint reading segments, faster running and an earned momentum streak. */
    public static final int SKYBOUND=4;
    /** Course version 5 (Skybound Trials): v4 plus obstacle zones, jump / dodge, rising gates and recovery (RushTrials). */
    public static final int TRIALS=RushTrials.VERSION;
    /** Course version 6 (Reforged): manual movement, open edges, moving walls, ten hazards, orbs (RushReforged). */
    public static final int REFORGED=RushReforged.VERSION;
    /** Course version 7 (Hardcore): no railings, harder tiers 5–6, four more obstacles, momentum falls (RushReforged). */
    public static final int HARDCORE=RushReforged.HARDCORE;
    public static final double V4_BASE=200, V4_SPRINT=270, V4_DASH=410, V4_DASH_TIME=.25, V4_RUSH=320, V4_LATERAL=470, MOMENTUM_STEP=.04;
    public static final int MOMENTUM_CAP=5;
    public static class Racer {
        public String id,name,botLevel,phase="RUNNING",effect="",lastSkill="";
        public Long userId;
        public boolean ready,connected=true,sprint;
        public double x=500,y,vx,speed,stamina=100,energy,dash,rush,dashCooldown,phaseTime,recoilFrom=-1;
        public double effectUntil,immuneUntil,inputAt=-100,seenAt,botAt,botSkillAt;
        public double horizontal; public Double target;
        public int checkpoint,selected=-1,openGate=-1,rejected=-1,mistakes,charges,rank,streak,bestStreak;
        public long lastSeq=-1,decisions,skillSerial; public double finishAt=-1;
        // Version 5: height, jump / dodge requests (monotonic counters from the input lease), recovery and the racer's own rising gate.
        public double z,vz,jumpAt=-1,landAt=-100,dodge,dodgeDir,dodgeCooldown,guard,kvx,kvy,riseStart=-1,dropStart=-1,dropFrom,hold=-1;
        public int jumpSeq,dodgeSeq,jumps,dodges,knocks,falls,riseCheckpoint=-1;
        public double botHazardAt,botIgnoreUntil; public boolean botAvoiding;
        /** The racer's chosen hero (LYRA / KAI, allow-listed by RushCompetitiveService). Cosmetic only: never read by the simulation. */
        public String hero="LYRA";
        /** What the racer wears (`AvatarLookCode`): relayed to the other screens, never read by the simulation. */
        public String look="";
        // Version 6: forward input and velocity, the crossing floor of the current segment, door slide carry, orbs and buffs.
        public double forward,vy,floorY=-80,lastSlide,speedUntil=-1,shieldUntil=-1,dashX,dashY=1,botForward,botMistakeUntil=-1,botTargetX=500;
        // Version 7: where the racer left the road (its respawn is chosen from there).
        public double fallX=500,fallY;
        public int shield,shieldBlocks,orbSerial,botDoor=-1; public boolean botLeap,botFlawed; public String lastOrb="",botJudged="";
        public List<Integer> orbs=new ArrayList<>();
        public Map<String,Double> cooldowns=new HashMap<>();
        public Map<Integer,List<Integer>> orders=new HashMap<>();
        public Set<String> tried=new HashSet<>();
        public Map<Long,String> inputs=new LinkedHashMap<>();
        public Racer() {}
        public Racer(String id,Long user,String name,String level){this.id=id;userId=user;this.name=name;botLevel=level;}
        public boolean bot(){return botLevel!=null;}
        public boolean terminal(){return phase.equals("FINISHED")||phase.equals("DNF");}
    }
    public static class Race {
        public UUID matchId=UUID.randomUUID(); public String status="WAITING",reason="",contentVersion="",difficulty="MEDIUM";
        public long seed,steps,revision; public double elapsed,accumulator,firstFinish=-1;
        // Missing fields in stored snapshots retain the original geometry.
        public int courseVersion=1; public double spacing=SPACING;
        /** Version 4+: cumulative wall positions, one reading segment per checkpoint. */
        public List<Double> boundaries=new ArrayList<>();
        /** Version 5: obstacle zones (at most one per segment) and the walls that rise. */
        public List<RushTrials.Hazard> hazards=new ArrayList<>(); public List<Boolean> rising=new ArrayList<>();
        /** Version 6: per-wall motion and the course's orbs. */
        public List<RushReforged.Wall> walls=new ArrayList<>(); public List<RushReforged.Orb> orbs=new ArrayList<>();
        public List<Pinned> questions=new ArrayList<>(); public List<Racer> racers=new ArrayList<>();
        public Race() {}
        /** A Skybound (v4) course: kept for stored-race compatibility and its own tests. */
        public Race(List<Pinned> questions,long seed){this.questions=List.copyOf(questions);this.seed=seed;courseVersion=SKYBOUND;boundaries=boundaries(questions);spacing=meanSpacing(boundaries);}
        /** A Skybound Trials (v5) course planned from the seed and the question difficulty. */
        public Race(List<Pinned> questions,long seed,String difficulty){
            this.questions=List.copyOf(questions);this.seed=seed;this.difficulty=difficulty==null?"MEDIUM":difficulty;courseVersion=TRIALS;
            var plan=RushTrials.plan(this.questions,seed,this.difficulty);boundaries=new ArrayList<>(plan.boundaries());hazards=new ArrayList<>(plan.hazards());rising=new ArrayList<>(plan.rising());spacing=meanSpacing(boundaries);
        }
        /** A course of the given version (5 = Trials, 6 = Reforged) planned from the seed and the question difficulty. */
        public Race(List<Pinned> questions,long seed,String difficulty,int version){
            this(questions,seed,difficulty);
            if(version>=REFORGED){var plan=RushReforged.plan(this.questions,seed,this.difficulty,version);courseVersion=version>=HARDCORE?HARDCORE:REFORGED;boundaries=new ArrayList<>(plan.boundaries());hazards=new ArrayList<>(plan.hazards());
                walls=new ArrayList<>(plan.walls());orbs=new ArrayList<>(plan.orbs());rising=new ArrayList<>(walls.stream().map(w->w.kind().equals("RISING")).toList());spacing=meanSpacing(boundaries);}
        }
    }
    /** Lease input. `jump` / `dodge` are monotonic request counters: a higher value asks for one jump / dodge. */
    public record Input(long seq,double horizontal,Double target,boolean sprint,int jump,int dodge,double forward) {
        public Input(long seq,double horizontal,Double target,boolean sprint){this(seq,horizontal,target,sprint,0,0,0);}
        public Input(long seq,double horizontal,Double target,boolean sprint,int jump,int dodge){this(seq,horizontal,target,sprint,jump,dodge,0);}
    }
    public static List<Integer> order(Race race,Racer p,int checkpoint){
        if(race.courseVersion<3)return p.orders.computeIfAbsent(checkpoint,k->{var a=new ArrayList<Integer>();for(int i=0;i<race.questions.get(k).options().size();i++)a.add(i);Collections.shuffle(a,new Random(race.seed^p.id.hashCode()^((long)k<<32)));return a;});
        allocateOrders(race,checkpoint);
        return p.orders.get(checkpoint);
    }
    /**
     * Every racer receives the same question with a private permutation. Correct
     * positions rotate through the available lanes, so their counts differ by at
     * most one even when there are more racers than gates. The entire assignment is
     * persisted in Racer.orders and is regenerated only before a final roster starts.
     */
    private static void allocateOrders(Race race,int checkpoint){
        if(race.racers.isEmpty())throw new RushException(409,"RACER_NOT_FOUND");
        boolean complete=race.racers.stream().allMatch(r->r.orders.containsKey(checkpoint));
        if(complete)return;
        for(var racer:race.racers)racer.orders.remove(checkpoint);
        var question=race.questions.get(checkpoint);int count=question.options().size(),correct=-1;
        for(int i=0;i<count;i++)if(question.options().get(i).id().equals(question.answerId()))correct=i;
        if(correct<0)throw new IllegalStateException("Quiz Rush answer is not an option");
        int first=Math.floorMod(Long.hashCode(race.seed^((long)checkpoint*0x9E3779B97F4A7C15L)),count);
        for(int racerIndex=0;racerIndex<race.racers.size();racerIndex++){
            var racer=race.racers.get(racerIndex);var wrong=new ArrayList<Integer>();
            for(int i=0;i<count;i++)if(i!=correct)wrong.add(i);
            Collections.shuffle(wrong,new Random(race.seed^((long)racer.id.hashCode()<<32)^checkpoint*0xBF58476D1CE4E5B9L));
            int correctPosition=(first+racerIndex)%count;wrong.add(correctPosition,correct);racer.orders.put(checkpoint,List.copyOf(wrong));
        }
    }
    public static double center(int index,int count){return 50+(index+.5)*900/count;}
    public static double courseSpacing(List<Pinned> questions){
        int words=questions.stream().mapToInt(q->(q.prompt()+" "+q.context()).trim().split("\\s+").length).max().orElse(0);
        return 2800+Math.min(900,Math.max(0,words-24)*18);
    }
    /**
     * Version 4 reading budget: every word of the prompt, context and all choices costs 80 units of road
     * (about 3 words per second at a sustained 240), plus a base to steer and decide; clamped to 1,700–4,200.
     */
    public static double segmentLength(Pinned q){
        var text=new StringBuilder(q.prompt()).append(' ').append(q.context());for(var o:q.options())text.append(' ').append(o.label());
        int words=text.toString().trim().split("\\s+").length;return Math.max(1700,Math.min(4200,1200+80.0*words));
    }
    public static List<Double> boundaries(List<Pinned> questions){var result=new ArrayList<Double>();double at=0;for(var q:questions){at+=segmentLength(q);result.add(at);}return result;}
    static double meanSpacing(List<Double> boundaries){return boundaries.isEmpty()?2800:boundaries.getLast()/boundaries.size();}
    public static boolean skybound(Race r){return r.courseVersion>=SKYBOUND&&r.boundaries.size()==r.questions.size();}
    public static boolean trials(Race r){return r.courseVersion>=TRIALS&&skybound(r);}
    public static boolean reforged(Race r){return r.courseVersion>=REFORGED&&skybound(r)&&r.walls.size()==r.questions.size();}
    public static boolean hardcore(Race r){return r.courseVersion>=HARDCORE&&reforged(r);}
    /** Version 6: the moving plane of this racer's current wall (the resting position for older courses). */
    public static double plane(Race r,Racer p){return reforged(r)&&p.checkpoint<r.questions.size()?RushReforged.plane(r.walls.get(p.checkpoint),barrier(r,p),r.elapsed):barrier(r,p);}
    public static double wall(Race r,int checkpoint){return skybound(r)?(checkpoint<0?0:r.boundaries.get(Math.min(checkpoint,r.boundaries.size()-1))):(checkpoint+1)*r.spacing;}
    public static double segmentStart(Race r,int checkpoint){return checkpoint<=0?0:wall(r,checkpoint-1);}
    public static double barrier(Race r,Racer p){return wall(r,p.checkpoint);}
    public static double finishLine(Race r){return skybound(r)?r.boundaries.getLast()+FINISH_OFFSET:r.questions.size()*r.spacing+FINISH_OFFSET;}
    /** Earned momentum: consecutive gates opened on the first try, a few percent each, never from position or time. */
    public static double momentum(Race r,Racer p){return skybound(r)?1+MOMENTUM_STEP*Math.min(MOMENTUM_CAP,p.streak):1;}
    static double base(Race r){return trials(r)?RushTrials.BASE:skybound(r)?V4_BASE:BASE_SPEED;}
    /** Current height of this racer's rising wall sill (0 when the wall does not rise). */
    public static double sill(Race r,Racer p){return trials(r)&&p.riseCheckpoint==p.checkpoint?RushTrials.sill(p.riseStart,p.dropStart,p.dropFrom,p.hold,r.elapsed):0;}
    public static RushTrials.Hazard hazard(Race r,Racer p){return trials(r)?RushTrials.hazard(r.hazards,p.checkpoint):null;}
    /** Inside an obstacle zone, or close enough that a 1.8 s tactic would still be running when the racer enters it. */
    static boolean inHazard(Race r,Racer p){
        if(reforged(r)){for(var h:RushReforged.hazards(r.hazards,p.checkpoint))if(p.y>h.from()-450&&p.y<h.to()+140)return true;return false;}
        var h=hazard(r,p);return h!=null&&p.y>h.from()-450&&p.y<h.to()+140;}
    public static void require(boolean ok,String code){if(!ok)throw new RushException(409,code);}
    public static void input(Race r,Racer p,Input in){
        require(!p.terminal()&&p.connected,"RACER_CLOSED");
        require(in!=null&&in.seq()>=0&&Double.isFinite(in.horizontal())&&Math.abs(in.horizontal())<=1&&
            (in.target()==null||Double.isFinite(in.target())&&in.target()>=76&&in.target()<=924)&&in.jump()>=0&&in.dodge()>=0&&Double.isFinite(in.forward())&&Math.abs(in.forward())<=1,"INVALID_INPUT");
        String key=in.horizontal()+":"+in.target()+":"+in.sprint()+":"+in.jump()+":"+in.dodge()+":"+in.forward();
        // An older lease: a repeat must match what was applied; one never seen (overtaken on the server's inbound thread
        // pool by a newer one) is simply stale — the newer lease already carries the keys and the action counters.
        if(in.seq()<=p.lastSeq){var seen=p.inputs.get(in.seq());if(seen!=null)require(key.equals(seen),"INPUT_REPLAY_CHANGED");return;}
        require(in.seq()-p.lastSeq<=100,"INPUT_SEQUENCE");
        p.lastSeq=in.seq();p.inputs.put(in.seq(),key);while(p.inputs.size()>64)p.inputs.remove(p.inputs.keySet().iterator().next());
        // Version 6 has no automatic steering: a door is reached only by the racer's own movement.
        p.horizontal=in.horizontal();p.target=reforged(r)?null:in.target();p.sprint=in.sprint();p.forward=in.forward();p.inputAt=r.elapsed;p.seenAt=r.elapsed;
        // A counter that moved forward is one request; a lagging or repeated lease never repeats an action.
        if(in.jump()>p.jumpSeq){p.jumpSeq=in.jump();if(trials(r))p.jumpAt=r.elapsed;}
        if(in.dodge()>p.dodgeSeq){p.dodgeSeq=in.dodge();if(trials(r))dodge(r,p);}
    }
    public static void start(Race r){
        require(r.status.equals("WAITING")||r.status.equals("QUEUED"),"MATCH_STARTED");
        require(r.racers.size()>=2&&r.racers.size()<=5&&r.racers.stream().allMatch(p->p.ready&&p.connected),"NOT_READY");
        if(r.courseVersion>=3){for(var p:r.racers)p.orders.clear();for(int checkpoint=0;checkpoint<r.questions.size();checkpoint++)allocateOrders(r,checkpoint);}
        r.status="COUNTDOWN";r.elapsed=-3;r.steps=0;
        for(int i=0;i<r.racers.size();i++){var p=r.racers.get(i);p.x=140+i*720/(r.racers.size()-1);p.seenAt=-3;p.inputAt=-100;p.botAt=0;if(reforged(r)){p.floorY=-80;p.lastSlide=RushReforged.slide(r.walls.getFirst(),0);}}
        r.revision++;
    }
    public static void boost(Race r,Racer p,String ability){
        require(active(r)&&p.connected&&p.phase.equals("RUNNING"),"ABILITY_UNAVAILABLE");
        if(ability.equals("dash")){require(p.dashCooldown<=0,"COOLDOWN");p.dash=skybound(r)?V4_DASH_TIME:.23;p.dashCooldown=4;
            // Version 6: the dash goes where the racer is steering (straight ahead with no input).
            if(reforged(r)){double h=p.horizontal,f=p.forward,len=Math.hypot(h,f);if(len<.05){h=0;f=1;len=1;}p.dashX=h/len;p.dashY=f/len;}}
        else if(ability.equals("rush")){require(p.energy>=100&&p.rush<=0,"NO_ENERGY");p.energy=0;p.rush=3;}
        else throw new RushException(400,"INVALID_ABILITY");
        p.seenAt=r.elapsed;r.revision++;
    }
    /** A sidestep burst: in the held steering direction, else the current drift, else toward the open side. Ground only. */
    static boolean dodge(Race r,Racer p){
        if(!active(r)||!p.phase.equals("RUNNING")||p.dodgeCooldown>0||p.z>0||p.effect.equals("ICE_LOCK"))return false;
        double dir=p.horizontal!=0?Math.signum(p.horizontal):Math.abs(p.vx)>20?Math.signum(p.vx):p.x<500?1:-1;
        p.dodge=RushTrials.DODGE_TIME;p.dodgeDir=dir;p.dodgeCooldown=RushTrials.DODGE_COOLDOWN;p.dodges++;r.revision++;return true;
    }
    public static boolean answer(Race r,Racer p,UUID question,UUID option){
        require(active(r)&&p.connected&&p.phase.equals("VALIDATING")&&p.checkpoint<r.questions.size(),"ANSWER_UNAVAILABLE");
        var q=r.questions.get(p.checkpoint);require(q.id().equals(question),"CHECKPOINT_CHANGED");
        var o=order(r,p,p.checkpoint);int chosen=o.get(p.selected);
        require(q.options().get(chosen).id().equals(option),"GATE_CHOICE_MISMATCH");
        boolean correct=q.answerId().equals(option);String attempt=question+":"+option;
        if(correct){boolean first=p.tried.stream().noneMatch(k->k.startsWith(question+":"));p.streak=first?p.streak+1:0;p.bestStreak=Math.max(p.bestStreak,p.streak);}else p.streak=0;
        if(correct){p.openGate=p.selected;p.energy=Math.min(100,p.energy+34);p.charges=Math.min(3,p.charges+1);p.phase="OPENING";}
        else{if(p.tried.add(attempt))p.mistakes++;p.rejected=p.selected;p.phase="STUMBLE";p.recoilFrom=p.y;p.dash=0;p.rush=0;if(p.bot()){p.target=null;p.botAt=r.elapsed+.1;p.botDoor=-1;}
            // Version 6: the sealed door throws the racer back; a moving wall keeps pressing while they recover.
            if(reforged(r)){p.kvx=0;p.kvy=-RushReforged.RECOIL;p.vx=0;p.vy=0;}
            // A rising gate resumes its climb from where it held while the answer was checked.
            if(p.hold>=0){p.riseStart=r.elapsed-p.hold/RushTrials.RISE_RATE;p.dropStart=-1;p.hold=-1;}}
        p.phaseTime=0;p.seenAt=r.elapsed;p.speed=0;r.revision++;return correct;
    }
    public static void skill(Race r,Racer actor,Racer target,String kind){
        require(Set.of("ICE_LOCK","TIME_SNARE","POSITION_SWAP").contains(kind),"INVALID_ABILITY");
        require(active(r)&&actor!=target&&actor.connected&&target.connected&&actor.phase.equals("RUNNING")&&target.phase.equals("RUNNING"),"ABILITY_UNAVAILABLE");
        require(actor.checkpoint==target.checkpoint&&Math.abs(actor.y-target.y)<=600,"TARGET_OUT_OF_RANGE");
        require(plane(r,actor)-actor.y>180&&plane(r,target)-target.y>180,"GATE_PROTECTED");
        // Tactics never stack on an obstacle: a racer inside (or entering) a hazard zone is protected.
        require(!inHazard(r,actor)&&!inHazard(r,target)&&target.guard<=0,"HAZARD_PROTECTED");
        require(actor.charges>0,"NO_CHARGE");require(r.elapsed>=actor.cooldowns.getOrDefault(kind,0.0),"COOLDOWN");
        require(r.elapsed>=target.immuneUntil&&r.elapsed>=target.effectUntil,"TARGET_PROTECTED");
        if(kind.equals("POSITION_SWAP")){
            // Swapping during the visible decision window would bypass its four-second
            // speed bound. New courses allow swaps only after preview, before doors reveal.
            if(reforged(r))require(actor.phaseTime>=2.5&&target.phaseTime>=2.5&&plane(r,actor)-actor.y>400&&plane(r,target)-target.y>400,"READING_PROTECTED");
            else if(r.courseVersion>=2)require(actor.phaseTime>=2.5&&target.phaseTime>=2.5&&barrier(r,actor)-actor.y>1700&&barrier(r,target)-target.y>1700,"READING_PROTECTED");
            require(actor.y-segmentStart(r,actor.checkpoint)>180&&target.y-segmentStart(r,target.checkpoint)>180,"GATE_PROTECTED");
            double x=actor.x,y=actor.y;actor.x=target.x;actor.y=target.y;target.x=x;target.y=y;
            actor.vx=target.vx=0;actor.speed=target.speed=0;actor.dash=target.dash=actor.rush=target.rush=0;
            actor.z=target.z=actor.vz=target.vz=0;actor.dodge=target.dodge=0;actor.vy=target.vy=0;actor.floorY=target.floorY=Math.min(actor.floorY,target.floorY);
            actor.target=target.target=null;target.immuneUntil=r.elapsed+3;
            actor.lastSkill=target.lastSkill=kind;target.skillSerial++;
        }else{target.effect=kind;if(kind.equals("ICE_LOCK")){target.vx=0;target.dodge=0;}target.effectUntil=r.elapsed+(kind.equals("ICE_LOCK")?1.2:1.8);target.immuneUntil=target.effectUntil+3;}
        actor.charges--;actor.cooldowns.put(kind,r.elapsed+12);actor.lastSkill=kind;actor.skillSerial++;
        actor.seenAt=r.elapsed;r.revision++;
    }
    public static boolean active(Race r){return r.status.equals("RUNNING")||r.status.equals("FINISHING");}
    public static void forfeit(Race r,Racer p){if(!p.terminal()){p.phase="DNF";p.speed=0;p.connected=false;r.revision++;}seal(r);}
    public static void advance(Race r,double seconds){
        if(!Double.isFinite(seconds)||seconds<0)throw new IllegalArgumentException("Invalid simulation time");
        if(!(active(r)||r.status.equals("COUNTDOWN")))return;
        r.accumulator+=seconds;
        while(r.accumulator+1e-10>=STEP&&!(r.status.equals("FINISHED")||r.status.equals("CANCELED"))){r.accumulator-=STEP;r.elapsed+=STEP;r.steps++;
            if(r.elapsed<-1e-10)continue;
            if(r.status.equals("COUNTDOWN")){r.status="RUNNING";r.elapsed=0;for(var p:r.racers)p.seenAt=0;r.revision++;}
            for(var p:r.racers){
                if(p.terminal())continue;
                if(!p.bot()&&r.elapsed-p.seenAt>2)p.connected=false;
                // Version 6: a disconnected racer stands still, but the world still acts on them (walls, wind, gaps, gravity).
                if(reforged(r)){if(!p.connected){p.horizontal=0;p.forward=0;p.sprint=false;p.jumpAt=-1;if(r.elapsed-p.seenAt>=30){forfeit(r,p);continue;}}
                    else if(p.bot())bot6(r,p);
                    move6(r,p,STEP,p.connected&&(p.bot()||r.elapsed-p.inputAt<=.35));continue;}
                if(!p.connected){p.speed=0;p.horizontal=0;p.target=null;p.sprint=false;p.jumpAt=-1;if(r.elapsed-p.seenAt>=30)forfeit(r,p);
                    // A disconnected racer still obeys gravity and the chasm (no frozen mid-air racer).
                    if(trials(r))airborne(r,p,STEP);continue;}
                if(p.bot())bot(r,p);
                move(r,p,STEP);
            }
            if(r.elapsed>=600||r.firstFinish>=0&&r.elapsed-r.firstFinish>=60){for(var p:r.racers)if(!p.terminal())forfeit(r,p);r.reason="TIME_LIMIT";}
            seal(r);
        }
    }
    /** Gravity for any racer above the road; landing clamps to the surface. */
    private static void airborne(Race r,Racer p,double dt){
        if(p.z<=0&&p.vz<=0){p.z=0;p.vz=0;return;}
        p.z+=p.vz*dt;p.vz-=RushTrials.GRAVITY*dt;if(p.z<=0){p.z=0;p.vz=0;p.landAt=r.elapsed;}
    }
    private static void move(Race r,Racer p,double dt){
        p.phaseTime+=dt;p.dashCooldown=Math.max(0,p.dashCooldown-dt);p.dash=Math.max(0,p.dash-dt);p.rush=Math.max(0,p.rush-dt);
        boolean v5=trials(r);
        if(v5){p.dodgeCooldown=Math.max(0,p.dodgeCooldown-dt);p.dodge=Math.max(0,p.dodge-dt);p.guard=Math.max(0,p.guard-dt);if(p.riseCheckpoint!=p.checkpoint){p.riseCheckpoint=p.checkpoint;p.riseStart=-1;p.dropStart=-1;p.hold=-1;}}
        if(r.elapsed>=p.effectUntil)p.effect="";
        // On a rising sill the racer stands on it while the answer is checked; at an ordinary door they land in the doorway.
        if(p.phase.equals("VALIDATING")){p.speed=0;if(v5){if(p.hold>=0){p.vz=0;p.z=p.hold;}else airborne(r,p,dt);}return;}
        if(p.phase.equals("STUMBLE")){p.speed=0;if(p.recoilFrom<0)p.recoilFrom=p.y;
            double t=Math.min(1,p.phaseTime/.32),ease=t*t*(3-2*t);
            p.y=p.recoilFrom+(Math.min(p.recoilFrom,barrier(r,p)-95)-p.recoilFrom)*ease;
            if(v5)airborne(r,p,dt);
            if(p.phaseTime>=.7){p.phase="RUNNING";p.phaseTime=0;}return;}
        if(p.phase.equals("OPENING")){
            p.speed=0;
            if(p.phaseTime>=.48){p.speed=base(r);p.y+=p.speed*dt;if(v5&&p.y>barrier(r,p)+10)airborne(r,p,dt);if(p.y>=barrier(r,p)+65){p.checkpoint++;p.openGate=-1;p.selected=-1;p.rejected=-1;p.phaseTime=0;
                p.phase=p.checkpoint==r.questions.size()?"FINISHING":"RUNNING";if(p.bot())p.target=null;p.botAt=r.elapsed+reaction(r,p);r.revision++;}}return;
        }
        if(p.phase.equals("FINISHING")){
            double finishing=v5?RushTrials.SPRINT*momentum(r,p):skybound(r)?V4_SPRINT*momentum(r,p):BASE_SPEED;p.x+=(500-p.x)*Math.min(1,3*dt);p.y+=finishing*dt;p.speed=finishing;
            if(v5)airborne(r,p,dt);
            if(r.courseVersion>=3?p.y>=finishLine(r):p.phaseTime>=2){p.y=r.courseVersion>=3?finishLine(r):p.y;p.phase="FINISHED";p.finishAt=r.elapsed;p.speed=0;if(r.firstFinish<0){r.firstFinish=r.elapsed;r.status="FINISHING";}r.revision++;}return;
        }
        if(v5&&p.phase.equals("FALLING")){
            p.speed=0;p.vx=0;p.z=-.5*RushTrials.GRAVITY*.6*p.phaseTime*p.phaseTime;
            if(p.phaseTime>=RushTrials.FALL_TIME){var h=hazard(r,p);p.y=Math.max(segmentStart(r,p.checkpoint)+70,h==null?p.y-RushTrials.RESPAWN_BACK:RushTrials.respawnY(h));
                if(h!=null&&h.lane()>=0)p.x=RushTrials.LANES[h.lane()];p.z=0;p.vz=0;p.kvx=p.kvy=0;p.phase="RUNNING";p.phaseTime=0;p.guard=RushTrials.RESPAWN_GUARD;p.target=null;p.botAt=r.elapsed+.2;r.revision++;}
            return;
        }
        if(v5&&p.phase.equals("KNOCKED")){
            double decay=Math.exp(-5*dt);p.x=Math.max(76,Math.min(924,p.x+p.kvx*dt));p.y=Math.max(segmentStart(r,p.checkpoint)+70,p.y+p.kvy*dt);p.kvx*=decay;p.kvy*=decay;p.speed=0;p.vx=0;
            airborne(r,p,dt);
            if(p.z<=0&&RushTrials.falls(hazard(r,p),p.x,p.y)){fall(r,p);return;}
            if(p.phaseTime>=RushTrials.KNOCK_TIME){p.phase="RUNNING";p.phaseTime=0;r.revision++;}
            return;
        }
        boolean live=p.bot()||r.elapsed-p.inputAt<=.35;
        double horizontal=live?p.horizontal:0;
        if(live&&p.target!=null)horizontal=Math.abs(p.target-p.x)>5?Math.signum(p.target-p.x):0;
        if(p.effect.equals("ICE_LOCK"))horizontal=0;
        boolean v4=skybound(r);
        // A landing takes a breath (JUMP_RECOVER) before the next take-off; a press just before it is buffered.
        if(v5&&p.jumpAt>=0){if(p.z<=0&&p.vz<=0&&r.elapsed-p.landAt>=RushTrials.JUMP_RECOVER){p.vz=RushTrials.JUMP_SPEED;p.jumps++;p.jumpAt=-1;r.revision++;}else if(r.elapsed-p.jumpAt>RushTrials.JUMP_BUFFER)p.jumpAt=-1;}
        if(v5&&p.dodge>0)p.vx=p.dodgeDir*RushTrials.DODGE_SPEED;
        else p.vx+=(horizontal*(v5?RushTrials.LATERAL:v4?V4_LATERAL:430)-p.vx)*Math.min(1,dt*28);
        double oldX=p.x,nextX=p.x+p.vx*dt;p.x=Math.max(76,Math.min(924,nextX));
        if(live&&!p.effect.equals("ICE_LOCK")&&p.dodge<=0&&p.target!=null&&(p.target-oldX)*(p.target-nextX)<=0)p.x=p.target;
        boolean sprint=live&&p.sprint&&p.stamina>0;p.stamina=Math.max(0,Math.min(100,p.stamina+(sprint?-30:19)*dt));
        double desired=v5?(p.dash>0?RushTrials.DASH:p.rush>0?RushTrials.RUSH:sprint?RushTrials.SPRINT:RushTrials.BASE)*momentum(r,p)
            :v4?(p.dash>0?V4_DASH:p.rush>0?V4_RUSH:sprint?V4_SPRINT:V4_BASE)*momentum(r,p):p.dash>0?330:p.rush>0?255:sprint?210:BASE_SPEED;
        if(p.effect.equals("TIME_SNARE"))desired=Math.min(95,desired);
        p.speed+=(desired-p.speed)*Math.min(1,dt*18);
        // Snare takes effect immediately, not after a high-speed easing tail.
        if(p.effect.equals("TIME_SNARE"))p.speed=Math.min(95,p.speed);
        double nextY=p.y+p.speed*dt;
        if(v5){
            airborne(r,p,dt);
            var h=hazard(r,p);
            if(h!=null){
                p.x=RushTrials.millPillar(h,p.x,nextY);
                if(p.z<=0&&RushTrials.falls(h,p.x,nextY)){p.y=nextY;fall(r,p);return;}
                if(p.guard<=0){var hit=RushTrials.hit(h,r.elapsed,p.x,nextY,p.z);if(hit!=null){p.y=nextY;knock(r,p,hit);return;}}
            }
            // Arm this racer's rising wall as they enter its approach; the sill begins to climb after a visible wait.
            if(RushTrials.rising(r.rising,p.checkpoint)&&p.riseStart<0&&nextY>=barrier(r,p)-RushTrials.RISE_ZONE){p.riseStart=r.elapsed+RushTrials.RISE_WAIT;r.revision++;}
        }
        if(nextY>=barrier(r,p)-RADIUS){
            int count=r.questions.get(p.checkpoint).options().size(),index=Math.min(count-1,Math.max(0,(int)((p.x-50)/(900/count))));
            double opening=900.0/count*(r.courseVersion>=2?.22:.38)-RADIUS,sill=sill(r,p);
            if(v5&&sill>p.z+RushTrials.SILL_STEP){
                // The sill rose above this racer's reach: bounce off the plinth; the gate settles and climbs again.
                p.y=barrier(r,p)-RADIUS;p.recoilFrom=p.y;p.phase="STUMBLE";p.phaseTime=0;p.selected=-1;p.dash=0;p.rush=0;p.speed=0;
                p.dropStart=r.elapsed;p.dropFrom=sill;p.riseStart=r.elapsed+RushTrials.DROP_TIME+RushTrials.REARM;
            }
            else if(Math.abs(p.x-center(index,count))>opening){p.y=barrier(r,p)-RADIUS;p.recoilFrom=p.y;p.phase="STUMBLE";p.phaseTime=0;p.selected=-1;p.dash=0;p.rush=0;p.speed=0;}
            else{p.y=barrier(r,p)-RADIUS;p.selected=index;p.phase="VALIDATING";p.phaseTime=0;p.speed=0;if(v5&&sill>0){p.hold=sill;p.z=Math.max(p.z,sill);p.vz=0;}if(p.bot())p.botAt=r.elapsed+reaction(r,p);}
            r.revision++;return;
        }p.y=nextY;
    }
    // ───────────────────────────── Version 6 (Reforged) ─────────────────────────────
    /** Collision half-opening of a doorway for the racer's centre (the world draws the door at this + radius). */
    public static double doorHalf(int count){return 900.0/count*.22-RADIUS;}
    /** True when this racer already tried door `index` of the current question (that door stays sealed: it is stone). */
    static boolean sealed(Race r,Racer p,int index){
        var q=r.questions.get(p.checkpoint);var o=order(r,p,p.checkpoint);return index>=0&&index<o.size()&&p.tried.contains(q.id()+":"+q.options().get(o.get(index)).id());
    }
    static void collect(Race r,Racer p,double y){
        for(var o:r.orbs){
            if(o.checkpoint()!=p.checkpoint||p.orbs.contains(o.id())||!RushReforged.touches(o,p.x,y,p.z))continue;
            p.orbs.add(o.id());p.orbSerial++;p.lastOrb=o.kind();r.revision++;
            switch(o.kind()){
                case "SPEED"->p.speedUntil=r.elapsed+RushReforged.SPEED_TIME;
                case "ENERGY"->p.energy=Math.min(100,p.energy+RushReforged.ENERGY_ORB);
                default->{p.shield=1;p.shieldUntil=r.elapsed+RushReforged.SHIELD_TIME;}
            }
        }
    }
    /** Racers in contact with stone of an advancing wall are pushed back with it; nothing ever passes through stone. */
    private static void pressed(Race r,Racer p,double front){if(p.checkpoint<r.questions.size()&&p.y>front){p.y=front;p.vy=Math.min(p.vy,0);}}
    /** The crossing floor always; on version 6 also the railings (version 7 has none: an edge is a drop). */
    private static void floorAndRails(Racer p,List<RushTrials.Hazard> hz,boolean open){
        if(p.y<p.floorY){p.y=p.floorY;p.vy=Math.max(0,p.vy);}
        if(!open&&RushReforged.openHalf(hz,p.y)<0){double c=Math.max(500-RushReforged.RAIL,Math.min(500+RushReforged.RAIL,p.x));if(c!=p.x){p.x=c;p.vx=0;}}
    }
    private static void respawn(Race r,Racer p,List<RushTrials.Hazard> hz){
        if(hardcore(r)){double[] at=RushReforged.respawnAt(hz,p.fallX,p.fallY);double y=Math.max(p.floorY+20,at[1]);if(p.checkpoint<r.questions.size())y=Math.min(y,plane(r,p)-RADIUS-60);p.y=y;p.x=at[0];}
        else{RushTrials.Hazard h=RushReforged.zone(hz,p.y);if(h==null)for(var c:hz)if(c.from()<=p.y+1)h=c;
        p.y=Math.max(p.floorY+20,h==null?p.y-RushReforged.RESPAWN_BACK:RushReforged.respawnY(h));p.x=h==null?500:RushReforged.respawnX(h);}
        p.z=0;p.vz=0;p.vx=0;p.vy=0;p.kvx=p.kvy=0;p.phase="RUNNING";p.phaseTime=0;p.guard=RushTrials.RESPAWN_GUARD;p.target=null;p.botAt=r.elapsed+.2;r.revision++;
    }
    /**
     * One authoritative step of a version 6 racer. `control` is false for a racer whose input lease lapsed (it stands).
     * There is no automatic movement: speed comes only from the racer's own input, a dash, a knock, wind or a stone.
     */
    static void move6(Race r,Racer p,double dt,boolean control){
        double t=r.elapsed;
        p.phaseTime+=dt;p.dashCooldown=Math.max(0,p.dashCooldown-dt);p.dash=Math.max(0,p.dash-dt);p.rush=Math.max(0,p.rush-dt);
        p.dodgeCooldown=Math.max(0,p.dodgeCooldown-dt);p.dodge=Math.max(0,p.dodge-dt);p.guard=Math.max(0,p.guard-dt);
        if(p.shield>0&&t>=p.shieldUntil)p.shield=0;
        if(t>=p.effectUntil)p.effect="";
        if(p.riseCheckpoint!=p.checkpoint){p.riseCheckpoint=p.checkpoint;p.riseStart=-1;p.dropStart=-1;p.hold=-1;}
        if(p.terminal())return;
        var hz=RushReforged.hazards(r.hazards,p.checkpoint);boolean gated=p.checkpoint<r.questions.size(),open=hardcore(r);
        var w=gated?r.walls.get(p.checkpoint):null;int count=gated?r.questions.get(p.checkpoint).options().size():3;
        double planeY=gated?RushReforged.plane(w,barrier(r,p),t):0,slide=gated?RushReforged.slide(w,t):0,front=planeY-RADIUS,half=doorHalf(count);
        double carry=slide-p.lastSlide;p.lastSlide=slide;
        switch(p.phase){
            case "VALIDATING"->{p.vx=p.vy=0;p.speed=0;p.y=front;p.x+=carry;if(p.hold>=0){p.vz=0;p.z=p.hold;}else airborne(r,p,dt);return;}
            case "OPENING"->{p.vx=p.vy=0;p.speed=0;p.y=front;p.x+=carry;airborne(r,p,dt);if(p.phaseTime>=.48){p.phase="RUNNING";p.phaseTime=0;r.revision++;}return;}
            case "STUMBLE"->{double decay=Math.exp(-6*dt);p.y+=p.kvy*dt;p.kvy*=decay;p.vx=0;p.vy=0;p.speed=0;floorAndRails(p,hz,open);pressed(r,p,front);airborne(r,p,dt);
                if(p.phaseTime>=RushReforged.STUMBLE_TIME){p.phase="RUNNING";p.phaseTime=0;r.revision++;}return;}
            case "FALLING"->{p.speed=0;p.vx=p.vy=0;
                // Version 7: the body keeps the momentum it left the road with (eased by air), never through a wall.
                if(open){double decay=Math.exp(-RushReforged.FALL_DRAG*dt);p.x+=p.kvx*dt;p.y=Math.max(p.floorY,p.y+p.kvy*dt);if(gated)p.y=Math.min(p.y,front);p.kvx*=decay;p.kvy*=decay;}
                p.z=-.5*RushTrials.GRAVITY*.6*p.phaseTime*p.phaseTime;if(p.phaseTime>=RushTrials.FALL_TIME)respawn(r,p,hz);return;}
            case "KNOCKED"->{double decay=Math.exp(-5*dt);p.x+=p.kvx*dt;p.y+=p.kvy*dt;p.kvx*=decay;p.kvy*=decay;p.vx=p.vy=0;p.speed=0;floorAndRails(p,hz,open);pressed(r,p,front);airborne(r,p,dt);
                if(p.z<=0&&RushReforged.falls(hz,p.x,p.y,t,open)){fall(r,p);return;}
                if(p.phaseTime>=RushTrials.KNOCK_TIME){p.phase="RUNNING";p.phaseTime=0;r.revision++;}return;}
            default->{}
        }
        if(!p.phase.equals("RUNNING")&&!p.phase.equals("FINISHING"))return;
        double h=control?p.horizontal:0,f=control?p.forward:0;if(p.effect.equals("ICE_LOCK"))h=0;
        double len=Math.hypot(h,f);if(len>1){h/=len;f/=len;len=1;}
        boolean moving=len>.05,air=p.z>0||p.vz>0,sprint=control&&p.sprint&&p.stamina>0&&moving;
        p.stamina=Math.max(0,Math.min(100,p.stamina+(sprint?-30:19)*dt));
        double s=p.rush>0?RushReforged.RUSH:sprint?RushReforged.SPRINT:RushReforged.MOVE;
        s*=momentum(r,p);if(t<p.speedUntil)s*=RushReforged.SPEED_ORB;if(p.effect.equals("TIME_SNARE"))s=Math.min(s,RushReforged.SNARE);
        if(p.dash>0){double d=RushReforged.DASH*momentum(r,p);p.vx=p.dashX*d/RushReforged.KX;p.vy=p.dashY*d/RushReforged.KY;}
        else{double k=Math.min(1,dt*(air?RushReforged.AIR:moving?RushReforged.ACCEL:RushReforged.BRAKE));
            p.vx+=(h*s/RushReforged.KX-p.vx)*k;p.vy+=(f*s*(f<0?RushReforged.BACK:1)/RushReforged.KY-p.vy)*k;}
        if(p.effect.equals("TIME_SNARE"))p.vy=Math.min(p.vy,RushReforged.SNARE/RushReforged.KY);
        // A landing takes a breath (JUMP_RECOVER) before the next take-off; a press just before it is buffered.
        if(p.jumpAt>=0){if(p.z<=0&&p.vz<=0&&t-p.landAt>=RushTrials.JUMP_RECOVER){p.vz=RushTrials.JUMP_SPEED;p.jumps++;p.jumpAt=-1;r.revision++;}else if(t-p.jumpAt>RushTrials.JUMP_BUFFER)p.jumpAt=-1;}
        if(p.dodge>0)p.vx=p.dodgeDir*RushTrials.DODGE_SPEED;
        double y0=p.y,nextX=p.x+(p.vx+RushReforged.drift(hz,p.x,p.y,t,!air))*dt,nextY=p.y+p.vy*dt;
        if(nextY<p.floorY){nextY=p.floorY;p.vy=Math.max(0,p.vy);}
        // Version 6: a railing ends where an open span begins: coming off the span outside the rail line, its end post stops you.
        if(!open&&RushReforged.openHalf(hz,nextY)<0&&RushReforged.openHalf(hz,p.y)>=0&&Math.abs(nextX-500)>RushReforged.RAIL){nextY=p.y;p.vy=0;}
        if(!open&&RushReforged.openHalf(hz,nextY)<0){double c=Math.max(500-RushReforged.RAIL,Math.min(500+RushReforged.RAIL,nextX));if(c!=nextX){nextX=c;p.vx=0;}}
        // Inside a doorway the jambs hold the racer in the opening.
        boolean doorway=gated&&p.openGate>=0&&y0>front-1;double door=gated&&p.openGate>=0?center(p.openGate,count)+slide:500;
        if(doorway&&Math.abs(p.x-door)<=half+.5)nextX=Math.max(door-half,Math.min(door+half,nextX));else doorway=false;
        p.x=RushReforged.pillar(hz,nextX,nextY);
        airborne(r,p,dt);
        p.speed=Math.hypot(p.vx*RushReforged.KX,p.vy*RushReforged.KY)/RushReforged.KY;
        if(p.z<=0&&RushReforged.falls(hz,p.x,nextY,t,open)){p.y=nextY;fall(r,p);return;}
        if(p.guard<=0)for(var hazard:hz){var hit=RushReforged.hit(hazard,t,p.x,nextY,p.z);if(hit==null)continue;
            // An orb shield takes the blow instead of the racer.
            if(p.shield>0){p.shield=0;p.shieldBlocks++;p.guard=RushReforged.SHIELD_GUARD;r.revision++;break;}
            p.y=nextY;knock(r,p,hit);return;}
        collect(r,p,nextY);
        if(!gated){p.y=nextY;if(p.y>=finishLine(r)){p.y=finishLine(r);p.phase="FINISHED";p.finishAt=t;p.speed=0;p.vx=p.vy=0;if(r.firstFinish<0){r.firstFinish=t;r.status="FINISHING";}r.revision++;}return;}
        // Arm this racer's rising wall as they enter its approach; the sill begins to climb after a visible wait.
        if(RushTrials.rising(r.rising,p.checkpoint)&&p.riseStart<0&&nextY>=barrier(r,p)-RushTrials.RISE_ZONE){p.riseStart=t+RushTrials.RISE_WAIT;r.revision++;}
        if(doorway||nextY>=front&&p.openGate>=0&&Math.abs(p.x-door)<=half){
            if(nextY>=planeY+65){p.checkpoint++;p.floorY=planeY+30;p.openGate=-1;p.selected=-1;p.rejected=-1;p.phaseTime=0;p.y=nextY;
                p.phase=p.checkpoint==r.questions.size()?"FINISHING":"RUNNING";p.lastSlide=p.checkpoint<r.questions.size()?RushReforged.slide(r.walls.get(p.checkpoint),t):0;
                if(p.bot()){p.target=null;p.botDoor=-1;}p.botAt=t+reaction(r,p);r.revision++;return;}
            p.y=nextY;return;
        }
        if(nextY>=front){
            int index=Math.min(count-1,Math.max(0,(int)((p.x-slide-50)/(900.0/count))));
            boolean inside=Math.abs(p.x-slide-center(index,count))<=half;double sill=sill(r,p);
            if(sill>p.z+RushTrials.SILL_STEP){
                // The sill rose above this racer's reach: bounce off the plinth; the gate settles and climbs again.
                p.y=front;p.phase="STUMBLE";p.phaseTime=0;p.kvy=-RushReforged.BUMP;p.selected=-1;p.dash=0;p.vx=p.vy=0;
                p.dropStart=t;p.dropFrom=sill;p.riseStart=t+RushTrials.DROP_TIME+RushTrials.REARM;r.revision++;return;
            }
            if(inside&&p.openGate<0&&!RushReforged.shut(w,t)&&!sealed(r,p,index)){
                p.y=front;p.selected=index;p.phase="VALIDATING";p.phaseTime=0;p.speed=0;p.vx=p.vy=0;if(sill>0){p.hold=sill;p.z=Math.max(p.z,sill);p.vz=0;}
                if(p.bot())p.botAt=t+reaction(r,p);r.revision++;return;
            }
            // Stone (or a shutter, or a sealed door): a hard bump bounces the racer back, a slow touch only stops them.
            if(p.vy>RushReforged.BUMP_SPEED){p.y=front;p.phase="STUMBLE";p.phaseTime=0;p.kvy=-RushReforged.BUMP;p.selected=-1;p.dash=0;p.vx=p.vy=0;r.revision++;return;}
            nextY=front;p.vy=Math.min(p.vy,0);
        }
        p.y=nextY;pressed(r,p,front);
    }
    private static Random botRandom(Race r,Racer p){return decision(r,p);}
    /** A movement decision: lateral and forward input (−1..1), whether to leap now, the target x, and how soon a naive straight run meets trouble. */
    public record Steer(double horizontal,double forward,boolean leap,double target,double danger) {}
    /**
     * The best of a handful of moves near obstacles, judged against the same hazard functions and body physics as the
     * authority: forward, slow, wait or step back; hold the line, head for the goal or a lane; leap now, soon or not.
     * Used by Echo Bots and by test pilots; it decides nothing about answers.
     */
    public static Steer steer(List<RushTrials.Hazard> hz,double t,double x,double y,double z,double vx,double vy,double vz,double goal){return steer(hz,t,x,y,z,vx,vy,vz,goal,false,1);}
    public static Steer steer(List<RushTrials.Hazard> hz,double t,double x,double y,double z,double vx,double vy,double vz,double goal,boolean open){return steer(hz,t,x,y,z,vx,vy,vz,goal,open,1);}
    /** `open` (version 7): edges are drops everywhere, and the footholds of narrow obstacles join the candidate lines. */
    /** `scale`: the runner's speed factor (momentum, speed orb), so moves are judged at the pace the body really has. */
    public static Steer steer(List<RushTrials.Hazard> hz,double t,double x,double y,double z,double vx,double vy,double vz,double goal,boolean open,double scale){
        double bestScore=-1e9,bestF=1,bestX=x,bestLeap=-1;
        double[] leaps={-1,0,.2,.4};double lane=RushTrials.LANES[Math.abs(goal-200)<Math.abs(goal-500)?0:Math.abs(goal-800)<Math.abs(goal-500)?2:1];
        double[] base={x,goal,500,x<500?Math.min(800,x+260):Math.max(200,x-260),lane},holds=open?RushReforged.footholds(hz,y):new double[0];
        double[] xs=Arrays.copyOf(base,base.length+holds.length);System.arraycopy(holds,0,xs,base.length,holds.length);
        // Stones are crossed by a chain of leaps: judge every leap move as a hop-on-landing chain there.
        boolean hop=open&&RushReforged.hopping(hz,y);
        // A person crossing stones also paces the run between full and half speed.
        double[] forwards=hop?new double[]{1,.7,.45,0,-.6}:new double[]{1,.45,0,-.6};
        for(double f:forwards)for(double xt:xs)for(double leap:leaps){
            if(leap>=0&&(z>0||vz>0||f<=0))continue;
            double tau=RushReforged.threat(hz,t,x,y,z,vx,vy,vz,xt,f,leap,1.2,open,hop,scale);
            double score=Math.min(tau,1.25)*1000+f*140-Math.abs(xt-x)*.12-(leap==0?25:leap>0?15:0)-Math.abs(xt-goal)*.02;
            if(score>bestScore){bestScore=score;bestF=f;bestX=xt;bestLeap=leap;}
        }
        double danger=RushReforged.threat(hz,t,x,y,z,vx,vy,vz,x,1,-1,1.2,open,false,scale);
        return new Steer(Math.abs(bestX-x)>8?Math.signum(bestX-x):0,bestF,bestLeap==0,bestX,danger);
    }
    /**
     * Echo Bots of version 6 play with the same controls as a person (forward / lateral input, jump, dodge, sprint):
     * near an obstacle they test a handful of moves against the same hazard functions the authority uses and take
     * the best, misjudging some by level (EASY really does get hit); away from obstacles they head for their chosen door.
     */
    static void bot6(Race r,Racer p){
        double t=r.elapsed;
        if(p.phase.equals("VALIDATING")){if(t>=p.botAt){var q=r.questions.get(p.checkpoint);answer(r,p,q.id(),q.options().get(order(r,p,p.checkpoint).get(p.selected)).id());}return;}
        if(!p.phase.equals("RUNNING")&&!p.phase.equals("FINISHING")){p.forward=0;p.horizontal=0;return;}
        boolean gated=p.checkpoint<r.questions.size();var hz=RushReforged.hazards(r.hazards,p.checkpoint);
        var w=gated?r.walls.get(p.checkpoint):null;int count=gated?r.questions.get(p.checkpoint).options().size():3;
        // Choose a door once per checkpoint attempt (accuracy by level), boosts with the same rules as a person.
        if(gated&&p.botDoor<0&&t>=p.botAt){
            var rand=decision(r,p);var q=r.questions.get(p.checkpoint);var o=order(r,p,p.checkpoint);
            double accuracy=switch(p.botLevel){case "EASY"->.60;case "MEDIUM"->.78;default->.92;};
            var candidates=new ArrayList<Integer>();int correct=0;
            for(int i=0;i<o.size();i++){var option=q.options().get(o.get(i));if(option.id().equals(q.answerId()))correct=i;else if(!p.tried.contains(q.id()+":"+option.id()))candidates.add(i);}
            p.botDoor=rand.nextDouble()<accuracy||candidates.isEmpty()?correct:candidates.get(rand.nextInt(candidates.size()));
            p.sprint=rand.nextDouble()<(p.botLevel.equals("EASY")?.4:.75);
            if(p.energy>=100&&p.rush<=0)try{boost(r,p,"rush");}catch(RushException ignored){}
            if(p.charges>0&&t>=p.botSkillAt){var other=r.racers.stream().filter(v->v!=p&&!v.terminal()).toList();if(!other.isEmpty())try{skill(r,p,other.get(rand.nextInt(other.size())),List.of("ICE_LOCK","TIME_SNARE","POSITION_SWAP").get(rand.nextInt(3)));}catch(RushException ignored){}p.botSkillAt=t+5;}
        }
        double goal=gated&&p.botDoor>=0?center(p.botDoor,count)+RushReforged.slide(w,t):500;
        if(gated&&p.botDoor<0)goal=p.x;
        // Ground orbs on the way (outside obstacle zones, far from the wall) are worth a small detour.
        if(gated&&plane(r,p)-p.y>700)for(var orb:r.orbs)if(orb.checkpoint()==p.checkpoint&&!p.orbs.contains(orb.id())&&orb.z()<=RushReforged.BODY+1&&orb.y()>p.y&&orb.y()-p.y<500&&RushReforged.zone(hz,orb.y())==null){goal=orb.x();break;}
        boolean near=false;for(var h:hz)if(p.y>h.from()-460&&p.y<h.to()+40)near=true;
        if(near){
            p.sprint=false; // careful through obstacles (the planner judges moves at running pace)
            boolean hop=hardcore(r)&&RushReforged.hopping(hz,p.y);
            if(t>=p.botHazardAt){
                p.botHazardAt=t+.1;

                // Each attempt at an obstacle is judged once (a retry after a hit or a fall is a new attempt).
                String attempt=p.checkpoint+":"+(p.falls+p.knocks);
                if(!attempt.equals(p.botJudged)){p.botJudged=attempt;p.botFlawed=botRandom(r,p).nextDouble()>=(hardcore(r)?skill7(p):skillOf(p));}
                if(t<p.botMistakeUntil||hop){/* committed to a misjudged move, or hopping stones (below) */}
                else{
                    var best=steer(hz,t,p.x,p.y,p.z,p.vx,p.vy,p.vz,goal,hardcore(r),hardcore(r)?momentum(r,p)*(t<p.speedUntil?RushReforged.SPEED_ORB:1):1);
                    p.botForward=best.forward();p.botTargetX=best.target();p.botLeap=best.leap();
                    // A misread obstacle: at the moment it matters, run straight on (EASY bots really do get caught).
                    if(p.botFlawed&&best.danger()<.45){p.botFlawed=false;p.botForward=1;p.botTargetX=p.x;p.botLeap=false;p.botMistakeUntil=t+.5;}
                }
            }
            // Version 7 stones are crossed hop by hop, decided every step; a misjudged take-off runs on without leaping.
            if(hop&&t>=p.botMistakeUntil){var s=RushReforged.hopPilot(hz,t,p.x,p.y,p.z,p.vx,p.vy,p.vz);p.botTargetX=s[0];p.botForward=s[1];p.botLeap=s[2]>0;
                if(p.botFlawed&&p.botLeap){p.botFlawed=false;p.botLeap=false;p.botMistakeUntil=t+.35;}}
            // Version 7 footholds are narrow: steer in proportion (a person feathers the keys), never bang-bang across them.
            p.forward=p.botForward;p.horizontal=hardcore(r)?Math.max(-1,Math.min(1,(p.botTargetX-p.x)/40)):Math.abs(p.botTargetX-p.x)>8?Math.signum(p.botTargetX-p.x):0;
            if(p.botLeap&&p.z<=0&&p.vz<=0&&p.jumpAt<0){p.jumpAt=t;p.botLeap=false;}
            return;
        }
        p.horizontal=Math.abs(goal-p.x)>8?Math.signum(goal-p.x)*Math.min(1,Math.abs(goal-p.x)/60):0;
        double gap=gated?plane(r,p)-RADIUS-p.y:9999;
        // Line up before touching the wall; wait for timed shutters; leap into a rising doorway.
        boolean aligned=Math.abs(goal-p.x)<=doorHalf(count)*.6;
        p.forward=!gated||p.botDoor>=0&&(aligned||gap>160)?1:0;
        if(gated&&RushReforged.shut(w,t+Math.max(0,gap)/Math.max(60,RushReforged.MOVE/RushReforged.KY))&&gap<220)p.forward=0;
        if(gated&&RushTrials.rising(r.rising,p.checkpoint)&&p.z<=0&&aligned){
            double speed=Math.max(p.vy,RushReforged.MOVE/RushReforged.KY),arrive=Math.max(0,gap)/speed;
            double need=RushTrials.sill(p.riseStart,p.dropStart,p.dropFrom,p.hold,t+arrive)-RushTrials.SILL_STEP;
            double height=RushTrials.JUMP_SPEED*arrive-.5*RushTrials.GRAVITY*arrive*arrive;
            if(need>0&&arrive<=.34&&height>=need&&t>=p.botIgnoreUntil){if(decision(r,p).nextDouble()<skillOf(p))p.jumpAt=t;else p.botIgnoreUntil=t+1;}
        }
        if(p.dashCooldown<=0&&p.forward>0&&gap>900&&decision(r,p).nextDouble()<.004)try{boost(r,p,"dash");}catch(RushException ignored){}
    }
    private static void knock(Race r,Racer p,RushTrials.Hit hit){
        // Version 7: a hit carries real force — near an open edge it can throw the runner into the abyss.
        double sx=hardcore(r)?RushReforged.KNOCK7_X:1,sy=hardcore(r)?RushReforged.KNOCK7_Y:1;
        p.phase="KNOCKED";p.phaseTime=0;p.kvx=hit.vx()*sx;p.kvy=hit.vy()*sy;p.vz=Math.max(p.vz,p.z>0?0:220);p.speed=0;p.dash=0;p.rush=0;p.dodge=0;
        p.guard=RushTrials.HIT_GUARD;p.knocks++;p.jumpAt=-1;if(p.bot())p.target=null;r.revision++;
    }
    private static void fall(Race r,Racer p){
        // Version 7: the fall keeps the momentum of the step (or the knock) that took the runner off the road.
        boolean keep=hardcore(r),knocked=p.phase.equals("KNOCKED");double carryX=keep?(knocked?p.kvx:p.vx):0,carryY=keep?(knocked?p.kvy:p.vy)*.6:0;
        p.fallX=p.x;p.fallY=p.y;
        p.phase="FALLING";p.phaseTime=0;p.speed=0;p.vx=0;p.dash=0;p.rush=0;p.dodge=0;p.kvx=carryX;p.kvy=carryY;p.vz=0;p.falls++;p.jumpAt=-1;r.revision++;
    }
    private static Random decision(Race r,Racer p){return new Random(r.seed^((long)p.id.hashCode()<<32)^++p.decisions*0x9E3779B97F4A7C15L);}
    private static double reaction(Race r,Racer p){var random=decision(r,p);return switch(Objects.toString(p.botLevel,"")){case "EASY"->1.8+random.nextDouble()*1.4;case "MEDIUM"->1+random.nextDouble();default->.55+random.nextDouble()*.7;};}
    private static double skillOf(Racer p){return switch(Objects.toString(p.botLevel,"")){case "EASY"->.7;case "MEDIUM"->.85;default->.95;};}
    /** Version 7 judgement per obstacle attempt: Easy misreads often, Medium sometimes, Hard almost never. */
    private static double skill7(Racer p){return switch(Objects.toString(p.botLevel,"")){case "EASY"->.62;case "MEDIUM"->.84;default->.965;};}

    /**
     * Echo Bots read the same hazard functions a player sees and act through the same jump / dodge / steering rules.
     * Each threat is judged once (a bot that misreads one keeps running into it), so EASY bots really do get hit.
     * Returns true while the bot is busy with an obstacle (door targeting waits until it is through).
     */
    private static boolean botTrials(Race r,Racer p){
        var h=hazard(r,p);
        boolean near=h!=null&&p.y>h.from()-700&&p.y<h.to()+60;
        if(!near){if(p.botAvoiding){p.botAvoiding=false;p.target=null;p.botAt=r.elapsed+.15;}return false;}
        p.botAvoiding=true;
        if(r.elapsed<p.botIgnoreUntil)return true;
        double speed=Math.max(p.speed,RushTrials.BASE);
        if(h.kind().equals("MILL")||h.kind().equals("CHASM")){
            // Jump hazards are judged every step: the take-off moment matters more than the plan.
            if(h.kind().equals("CHASM")&&h.lane()>=0&&!"EASY".equals(p.botLevel)&&p.y<RushTrials.chasmCenter(h)-200)p.target=RushTrials.LANES[h.lane()];
            else if(h.kind().equals("MILL")&&Math.abs(p.x-500)<70)p.target=p.x<500?380.0:620.0;
            if(p.z>0||p.vz>0||p.jumpAt>=0)return true;
            double tau=RushTrials.threat(h,r.elapsed,p.x,p.target==null?p.x:p.target,p.y,Math.max(p.speed,1),.45);
            if(h.kind().equals("CHASM")?tau<=.06:tau<=.3){if(decision(r,p).nextDouble()<skillOf(p))p.jumpAt=r.elapsed;else p.botIgnoreUntil=r.elapsed+.6;}
            return true;
        }
        if(r.elapsed<p.botHazardAt)return true;p.botHazardAt=r.elapsed+.1;
        double best=p.x,bestScore=-1;
        for(double x:new double[]{p.x,200,350,500,650,800}){double tau=RushTrials.threat(h,r.elapsed,p.x,x,p.y,speed,1.2);double score=Math.min(tau,1.3)*1000-Math.abs(x-p.x)*.2;if(score>bestScore){bestScore=score;best=x;}}
        double now=RushTrials.threat(h,r.elapsed,p.x,p.x,p.y,speed,.6);
        if(now<.6&&Math.abs(best-p.x)>20){
            if(decision(r,p).nextDouble()>=skillOf(p)){p.botIgnoreUntil=r.elapsed+.7;return true;}
            p.target=best;if(now<.3&&Math.abs(best-p.x)>110&&p.dodgeCooldown<=0){p.horizontal=Math.signum(best-p.x);dodge(r,p);}
        }else if(p.target==null||Math.abs(p.target-p.x)<6)p.target=best;
        return true;
    }
    /** Rising gates: leap into the doorway once the sill is above the road. */
    private static void botGate(Race r,Racer p){
        if(!RushTrials.rising(r.rising,p.checkpoint)||p.z>0)return;
        double gap=barrier(r,p)-RADIUS-p.y,speed=Math.max(p.speed,RushTrials.BASE),arrive=gap/speed;
        double need=RushTrials.sill(p.riseStart,p.dropStart,p.dropFrom,p.hold,r.elapsed+arrive)-RushTrials.SILL_STEP;
        // Jumping now puts the racer at this height when it meets the wall; the first moment it is enough, leap.
        double height=RushTrials.JUMP_SPEED*arrive-.5*RushTrials.GRAVITY*arrive*arrive;
        if(need>0&&arrive<=.34&&height>=need&&r.elapsed>=p.botIgnoreUntil){if(decision(r,p).nextDouble()<skillOf(p))p.jumpAt=r.elapsed;else p.botIgnoreUntil=r.elapsed+1;}
    }
    private static void bot(Race r,Racer p){
        if(p.phase.equals("VALIDATING")){if(r.elapsed>=p.botAt){var q=r.questions.get(p.checkpoint);answer(r,p,q.id(),q.options().get(order(r,p,p.checkpoint).get(p.selected)).id());}return;}
        if(!p.phase.equals("RUNNING"))return;
        if(trials(r)){if(botTrials(r,p))return;botGate(r,p);}
        if(p.target==null&&r.elapsed>=p.botAt){
            var rand=decision(r,p);var q=r.questions.get(p.checkpoint);var o=order(r,p,p.checkpoint);
            double accuracy=switch(p.botLevel){case "EASY"->.60;case "MEDIUM"->.78;default->.92;};
            var candidates=new ArrayList<Integer>();for(int i=0;i<o.size();i++){var option=q.options().get(o.get(i));if(!option.id().equals(q.answerId())&&!p.tried.contains(q.id()+":"+option.id()))candidates.add(i);}
            int correct=0;for(int i=0;i<o.size();i++)if(q.options().get(o.get(i)).id().equals(q.answerId()))correct=i;
            int chosen=rand.nextDouble()<accuracy||candidates.isEmpty()?correct:candidates.get(rand.nextInt(candidates.size()));
            p.target=center(chosen,o.size());p.sprint=rand.nextDouble()<(p.botLevel.equals("EASY")?.45:.8);p.botAt=r.elapsed+reaction(r,p);
            if(p.dashCooldown<=0&&rand.nextDouble()<.6)boost(r,p,"dash");if(p.energy>=100)boost(r,p,"rush");
            if(p.charges>0&&r.elapsed>=p.botSkillAt){var other=r.racers.stream().filter(v->v!=p&&!v.terminal()).toList();if(!other.isEmpty())try{skill(r,p,other.get(rand.nextInt(other.size())),List.of("ICE_LOCK","TIME_SNARE","POSITION_SWAP").get(rand.nextInt(3)));}catch(RushException ignored){}p.botSkillAt=r.elapsed+5;}
        }
    }
    private static void seal(Race r){
        if(!active(r))return;
        var finished=r.racers.stream().filter(p->p.finishAt>=0).sorted(Comparator.comparingDouble((Racer p)->p.finishAt).thenComparing(p->p.id)).toList();
        for(int i=0;i<finished.size();i++)finished.get(i).rank=i>0&&Math.abs(finished.get(i).finishAt-finished.get(i-1).finishAt)<STEP/2?finished.get(i-1).rank:i+1;
        if(r.racers.stream().allMatch(Racer::terminal)){r.status="FINISHED";if(r.reason.isEmpty())r.reason="COURSE_COMPLETE";r.revision++;}
    }
    private RushCompetition(){}
}
