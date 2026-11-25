package com.englishcoach.studyspace;

import com.englishcoach.echolife.EchoLifeGameService.EventWindow;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** One gathering at a real public venue. The enclosing study room owns the lock and the clock. */
final class StudyWorldEvent {
    record Intent(UUID invitation,String action) {}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    record View(UUID invitation,String id,String title,String zone,double x,double z,long endsAt,
                int present,int ready,boolean nearby,boolean joined,boolean readySelf,boolean organizer,
                long cheerAt,boolean celebrated,long serverNow) {}

    final UUID invitation=UUID.randomUUID();
    final long organizer,endsAt;
    final EventWindow event;
    final double x,z;
    private final Set<Long> joined=new HashSet<>(),ready=new HashSet<>();
    private long cheerAt;
    private boolean celebrated;

    StudyWorldEvent(long organizer,EventWindow event,StudyWorldPresence.Pose pose,long now,long roomExpiry) {
        this.organizer=organizer;
        this.event=event;
        endsAt=Math.min(roomExpiry,now+event.durationMs());
        x=pose.x();z=pose.z();
        joined.add(organizer);
    }

    private boolean nearby(StudySharedService.Member member,long now) {
        if(member==null || member.world.pose==null || now-member.world.seen>=StudyWorldPresence.EXPIRE_MS)return false;
        var p=member.world.pose;
        return event.zone().equals(p.zone()) && Math.abs(p.y())<=1.2 && Math.hypot(p.x()-x,p.z()-z)<=4.5;
    }

    boolean advance(Map<Long,StudySharedService.Member> members,long now) {
        if(now>=endsAt || !members.containsKey(organizer))return false;
        joined.retainAll(members.keySet());
        ready.removeIf(id->!joined.contains(id) || !nearby(members.get(id),now));
        if(!celebrated){
            if(ready.size()<2)cheerAt=0;
            else if(cheerAt==0)cheerAt=now+3000;
            else if(now>=cheerAt){
                celebrated=true;
                for(long id:ready){
                    var presence=members.get(id).world;
                    presence.emote="cheer";presence.emoteAt=now;
                }
            }
        }
        return true;
    }

    boolean act(StudySharedService.Member member,Intent intent,long now) {
        if(intent==null || !invitation.equals(intent.invitation()))return true;
        if("end".equals(intent.action()) && member.id==organizer)return false;
        if("leave".equals(intent.action())){joined.remove(member.id);ready.remove(member.id);return member.id!=organizer;}
        if(celebrated || !nearby(member,now))return true;
        if("join".equals(intent.action()))joined.add(member.id);
        if("ready".equals(intent.action()) && joined.contains(member.id))ready.add(member.id);
        return true;
    }

    View view(StudySharedService.Member self,Map<Long,StudySharedService.Member> members,long now) {
        if(self.world.pose==null)return null;
        int present=0;
        for(long id:joined)if(nearby(members.get(id),now))present++;
        return new View(invitation,event.id(),event.title(),event.zone(),x,z,endsAt,present,ready.size(),
                nearby(self,now),joined.contains(self.id),ready.contains(self.id),self.id==organizer,cheerAt,celebrated,now);
    }
}
