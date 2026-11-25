package com.englishcoach.quizrush;

import org.junit.jupiter.api.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static com.englishcoach.quizrush.RushCompetition.*;
import static org.junit.jupiter.api.Assertions.*;

/**
 * The browser predicts a racer with rushModel.stepRush and the server decides with move6: when the two models differ, every
 * snapshot corrects the runner (a visible snap). `netcode-parity.csv` holds the browser model's trajectories (written by
 * frontend/scripts/rush-netcode-parity.mjs) for movement, sprint, braking, dash, Echo Rush, dodge, jump and the two
 * tactics expiring mid-run; this test feeds the same inputs through the authority's own entry points (input, boost, one
 * 1/120 s move6 per step, as `advance` runs it) and requires the same state at every step.
 * Before 2026-10-26 Time Snare differed (the browser capped the forward speed after the step had moved: 0.1 s of W put the
 * prediction 4 units ahead of the server), and a dash / dodge lasted one step longer in the browser.
 */
class RushNetcodeParityTest {
    private record Scenario(String name,String effect,double until,double energy,List<String[]> rows) {}

    private static List<Scenario> scenarios()throws IOException{
        var result=new ArrayList<Scenario>();Scenario current=null;
        try(var in=RushNetcodeParityTest.class.getResourceAsStream("/quizrush/netcode-parity.csv")){
            assertNotNull(in,"netcode-parity.csv");
            for(String line:new String(in.readAllBytes(),StandardCharsets.UTF_8).split("\\R")){
                if(line.isBlank()||line.startsWith("# "))continue;
                if(line.startsWith("#scenario,")){var p=line.split(",",-1);current=new Scenario(p[1],p[2],Double.parseDouble(p[3]),Double.parseDouble(p[4]),new ArrayList<>());result.add(current);continue;}
                assertNotNull(current);current.rows().add(line.split(","));
            }
        }
        return result;
    }

    private static Race road(){
        var r=new Race();r.questions=RushTrialsTest.questions(3);r.courseVersion=HARDCORE;r.boundaries=new ArrayList<>(List.of(10000.0,20000.0,30000.0));
        r.walls=new ArrayList<>(Arrays.asList(null,null,null));r.rising=new ArrayList<>(List.of(false,false,false));r.status="RUNNING";r.elapsed=10;return r;
    }

    @Test void authorityFollowsTheBrowserModelStepForStep()throws IOException{
        var all=scenarios();assertTrue(all.size()>=13,"scenarios");
        for(var sc:all){
            var r=road();var p=new Racer("p1",1L,"probe",null);r.racers.add(p);
            p.phase="RUNNING";p.phaseTime=5;p.x=500;p.y=1000;p.energy=sc.energy();p.effect=sc.effect();p.effectUntil=sc.until();
            assertTrue(hardcore(r),"a version 7 road");
            long seq=0;int jumps=0,dodges=0;
            for(var row:sc.rows()){
                int step=Integer.parseInt(row[1]);double h=Double.parseDouble(row[2]),f=Double.parseDouble(row[3]);boolean sprint=row[4].equals("1");
                if(row[5].equals("1"))jumps++;if(row[6].equals("1"))dodges++;
                // The lease of this step (renewed every step, as a held key is), then any skill command, then one step.
                input(r,p,new Input(seq++,h,null,sprint,jumps,dodges,f));
                if(row[7].equals("1"))try{boost(r,p,"dash");}catch(RushException ignored){}
                if(row[8].equals("1"))try{boost(r,p,"rush");}catch(RushException ignored){}
                r.elapsed+=STEP;move6(r,p,STEP,true);
                String at=sc.name()+" step "+step;
                assertEquals(Double.parseDouble(row[9]),p.x,1e-6,at+" x");assertEquals(Double.parseDouble(row[10]),p.y,1e-6,at+" y");
                assertEquals(Double.parseDouble(row[11]),p.vx,1e-6,at+" vx");assertEquals(Double.parseDouble(row[12]),p.vy,1e-6,at+" vy");
                assertEquals(Double.parseDouble(row[13]),p.z,1e-6,at+" z");assertEquals(Double.parseDouble(row[14]),p.vz,1e-6,at+" vz");
                assertEquals(Double.parseDouble(row[15]),p.dash,1e-6,at+" dash");assertEquals(Double.parseDouble(row[16]),p.dodge,1e-6,at+" dodge");
                assertEquals(Double.parseDouble(row[17]),p.rush,1e-6,at+" rush");assertEquals(row[18],p.phase,at+" phase");
            }
        }
    }

    /** Codex audit 2026-10-25 (same start, 0.1 s of W under Time Snare): the authority's numbers the browser must match. */
    @Test void timeSnareMatchesTheAuditedAuthority(){
        var r=road();var p=new Racer("p1",1L,"probe",null);r.racers.add(p);p.phase="RUNNING";p.x=500;p.y=0;p.effect="TIME_SNARE";p.effectUntil=11;
        for(int k=0;k<12;k++){input(r,p,new Input(k,1,null,false,0,0,1));r.elapsed+=STEP;move6(r,p,STEP,true);}
        assertEquals(505.8406791928207,p.x,1e-9);assertEquals(2.9203395964103174,p.y,1e-9);assertEquals(91.96827098748045,p.vx,1e-9);assertEquals(45.984135493740226,p.vy,1e-9);
    }
}
