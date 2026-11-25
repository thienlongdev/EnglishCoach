package com.englishcoach.studyspace;

import org.junit.jupiter.api.Test;
import java.util.Map;
import static org.assertj.core.api.Assertions.assertThat;

class StudyWorldCourtTest {
    private final StudyWorldCourt court=new StudyWorldCourt();
    private final StudySharedService.Member north=new StudySharedService.Member(1,"A",0);
    private final StudySharedService.Member south=new StudySharedService.Member(2,"B",0);
    private final Map<Long,StudySharedService.Member> members=Map.of(1L,north,2L,south);
    private final StudyWorldPresence.Pose a=new StudyWorldPresence.Pose("park",49.2,0,1.8,0,"KAI",4.);
    private final StudyWorldPresence.Pose b=new StudyWorldPresence.Pose("park",54.2,0,5.6,0,"LYRA",9.);
    private long now=100;
    private void tick(long delta) {
        now+=delta; north.world.pose=a; south.world.pose=b; north.world.seen=now; south.world.seen=now;
        court.advance(members,now);
    }
    private void action(StudySharedService.Member player,String name) {
        var view=court.view(player.world.pose,now);
        court.act(player.id,player.world.pose,new StudyWorldCourt.Intent(name,view.revision()),now);
    }
    @Test void partnersRallyAcrossDifferentSizedPlansAndReplay() {
        tick(0); action(north,"join"); action(north,"strike");
        assertThat(court.view(a,now).phase()).isEqualTo("WAITING");
        action(south,"join");
        long serveRevision=court.view(b,now).revision();
        action(north,"strike");
        action(south,"strike");
        assertThat(court.view(a,now).returns()).isZero();
        tick(1500);
        court.act(south.id,b,new StudyWorldCourt.Intent("strike",serveRevision),now);
        assertThat(court.view(b,now).returns()).isZero();
        for (int i=1;i<=6;i++) {
            if(i>1)tick(1500);
            action(i%2==1?south:north,"strike");
            assertThat(court.view(a,now).returns()).isEqualTo(i);
        }
        assertThat(court.view(b,now).phase()).isEqualTo("COMPLETE");
        action(south,"replay"); assertThat(court.view(a,now).phase()).isEqualTo("SERVE");
        action(north,"strike"); tick(2500); assertThat(court.view(b,now).phase()).isEqualTo("MISSED");
    }
    @Test void shortDisconnectResumesAndLeavingReleasesTheSide() {
        tick(0); action(north,"join"); action(south,"join"); action(north,"strike");
        tick(1500); action(south,"strike");
        south.world.clear(); now+=700; north.world.seen=now; court.advance(members,now);
        assertThat(court.view(a,now).phase()).isEqualTo("PAUSED");
        tick(300); assertThat(court.view(a,now).phase()).isEqualTo("SERVE");
        assertThat(court.view(b,now).returns()).isOne();
        south.world.clear(); now+=13000; north.world.seen=now; court.advance(members,now);
        assertThat(court.view(a,now).south()).isNull();
        assertThat(court.view(a,now).phase()).isEqualTo("WAITING");
        action(north,"leave");
        assertThat(court.view(a,now).phase()).isEqualTo("OPEN");
    }
}
