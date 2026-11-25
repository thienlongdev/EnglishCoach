package com.englishcoach.studyspace;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.core.io.ClassPathResource;

/** Transient, room-owned equipment. All mutations run under the containing study room's lock. */
final class StudyWorldEquipment {
    record Intent(String action, String item, long revision) {}
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    record View(String id, String zone, double x, double z, double yaw, Long holder, long revision) {}
    private static final Set<String> OUTDOORS=Set.of("street","park","fair","greenway","campus","botanical","lantern_garden","fountain_plaza");
    private record Point(double x,double z) {}
    private static class Geometry {
        static final Map<String,Point> WAYPOINTS=load();
        static Map<String,Point> load(){
            try(var in=new ClassPathResource("echo-life/zone-waypoints.json").getInputStream()){
                return new ObjectMapper().readValue(in,new TypeReference<Map<String,Point>>(){});
            } catch(java.io.IOException e){throw new IllegalStateException("Missing shared city geometry",e);}
        }
    }
    private static final class Item {
        final String id;
        String zone;
        double x,z,yaw;
        Long holder;
        long revision=1;
        long movedAt;
        Item(String id,String zone,double x,double z,double yaw) {
            this.id=id;this.zone=zone;this.x=x;this.z=z;this.yaw=yaw;
        }
        void release() {holder=null;revision++;}
        View view() {return new View(id,zone,StudyWorldPresence.round3(x),StudyWorldPresence.round3(z),StudyWorldPresence.round3(yaw),holder,revision);}
    }
    private final Map<String,Item> items=Map.of("bike",new Item("bike","park",1.2,.8,Math.PI/2));

    void expire(Map<Long,StudySharedService.Member> members,long now) {
        for(Item item:items.values()) {
            if(item.holder==null)continue;
            var member=members.get(item.holder);
            if(member==null || member.world.pose==null || now-member.world.seen>=StudyWorldPresence.EXPIRE_MS) item.release();
        }
    }

    String update(long user,StudyWorldPresence.Pose pose,Intent intent,long now) {
        for(Item item:items.values()) {
            if(item.holder==null || item.holder!=user)continue;
            if(pose==null || !OUTDOORS.contains(pose.zone()) || !canFollow(item,pose,now)) item.release();
            else {item.zone=pose.zone();item.x=pose.x();item.z=pose.z();item.yaw=pose.yaw();item.movedAt=now;}
        }
        if(intent==null)return null;
        Item item=intent.item()==null?null:items.get(intent.item());
        if(item==null || intent.revision()!=item.revision)return "STALE_EQUIPMENT";
        if("release".equals(intent.action())) {
            if(item.holder==null || item.holder!=user)return "LEASE_REQUIRED";
            item.release();
            return "RELEASED";
        }
        if(!"claim".equals(intent.action()) || pose==null || !item.zone.equals(pose.zone()) ||
                Math.hypot(item.x-pose.x(),item.z-pose.z())>2.4 || Math.abs(pose.y())>1) return "OUT_OF_REACH";
        if(item.holder!=null || items.values().stream().anyMatch(v->v.holder!=null && v.holder==user))return "IN_USE";
        item.holder=user;item.revision++;item.movedAt=now;
        item.x=pose.x();item.z=pose.z();item.yaw=pose.yaw();
        return "CLAIMED";
    }
    private boolean canFollow(Item item,StudyWorldPresence.Pose pose,long now) {
        Point from=Geometry.WAYPOINTS.get(item.zone),to=Geometry.WAYPOINTS.get(pose.zone());
        if(from==null || to==null)return false;
        double dx=to.x+pose.x()-from.x-item.x,dz=to.z+pose.z()-from.z-item.z;
        double elapsed=Math.max(0,Math.min(1500,now-item.movedAt))/1000.0;
        // Plans are anchored to each learner's room size. Adjacent districts can differ slightly at their seam.
        return Math.hypot(dx,dz)<=8*elapsed+(item.zone.equals(pose.zone())?.4:3.0);
    }
    List<View> visible(StudyWorldPresence.Pose pose) {
        if(pose==null)return List.of();
        List<View> result=null;
        for(Item item:items.values())if(item.zone.equals(pose.zone())){
            if(result==null)result=new ArrayList<>(2);
            result.add(item.view());
        }
        return result==null?List.of():result;
    }
}
