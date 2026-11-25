package com.englishcoach.kingofenglish;
import java.util.*;
/** Selection preserves the maximum difficulty contract; scarce pools shorten rather than repeat. */
final class KingContentSelector {
    static List<String> sequence(Collection<KingBank.Item> items,String mode,int difficulty,int count,long seed){
        if(count<1)return List.of();
        var eligible=items.stream().filter(i->i.mode().equals(mode)&&i.status().equals("AUTO_VALIDATED"))
            .filter(i->difficulty==0||i.difficulty()<=difficulty).toList();
        var ids=new ArrayList<>(eligible.stream().map(KingBank.Item::id).distinct().toList());
        if(ids.isEmpty())throw new KingService.Rejection("CONTENT_UNAVAILABLE");
        Collections.shuffle(ids,new Random(seed));
        if(mode.equals("REFLEX")){
            var family=new HashMap<String,String>();eligible.forEach(i->family.put(i.id(),i.family()));
            var groups=new LinkedHashMap<String,ArrayDeque<String>>();
            for(var id:ids)groups.computeIfAbsent(family.get(id),k->new ArrayDeque<>()).add(id);
            var diverse=new ArrayList<String>();
            while(groups.values().stream().anyMatch(q->!q.isEmpty()))
                for(var q:groups.values())if(!q.isEmpty())diverse.add(q.remove());
            ids=diverse;
        }
        return List.copyOf(ids.subList(0,Math.min(count,ids.size())));
    }
}
