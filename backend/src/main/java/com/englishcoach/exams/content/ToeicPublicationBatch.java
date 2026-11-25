package com.englishcoach.exams.content;

import com.englishcoach.exams.repository.ExamContentRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import java.util.*;

/** One finite admin-approved batch. Every edition commits separately through the normal publishing transaction. */
@Service @Slf4j @RequiredArgsConstructor
public class ToeicPublicationBatch {
    public record Selected(UUID formId,String hash) {}
    public record Progress(int total,int published,Map<UUID,String> failures,boolean running) {}
    private final ToeicPackagePublication publication;
    private final ExamContentRepository repository;
    private volatile Progress progress = new Progress(0,0,Map.of(),false);

    public List<Selected> pending() {
        return publication.pendingDecisions().stream().map(d -> new Selected(d.formId(),d.hash())).toList();
    }

    public Progress progress() { return progress; }

    public synchronized Progress start(List<Selected> selected, long actor) {
        if (progress.running()) throw new IllegalStateException("TOEIC_BATCH_IN_PROGRESS");
        if (selected==null || selected.isEmpty() || selected.size()>500 || new HashSet<>(selected).size()!=selected.size())
            throw new IllegalArgumentException("TOEIC_BATCH_INVALID");
        var pending = new HashSet<>(pending());
        if (!pending.containsAll(selected)) throw new IllegalStateException("TOEIC_BATCH_SELECTION_CHANGED");
        var snapshot = List.copyOf(selected);
        var batchId=UUID.randomUUID().toString();
        repository.insertAuditEvent(actor,"TOEIC_OWNER_BATCH_AUTHORIZED","TOEIC_BATCH",batchId,null,null,
                "MFA-protected signed package selection: "+snapshot,null);
        progress = new Progress(snapshot.size(),0,Map.of(),true);
        Thread.startVirtualThread(() -> execute(snapshot,actor,batchId));
        return progress;
    }

    private void execute(List<Selected> selected,long actor,String batchId) {
        int published=0;
        Map<UUID,String> failures=new LinkedHashMap<>();
        try {
            for (var item:selected) {
                try {
                    if (!publication.publishIfCovered(item.formId(),actor))
                        throw new IllegalStateException("TOEIC_PUBLICATION_NOT_COVERED");
                    published++;
                } catch (RuntimeException ex) {
                    log.warn("TOEIC batch {} could not publish {}",batchId,item.formId(),ex);
                    failures.put(item.formId(),"PUBLICATION_FAILED");
                }
                progress=new Progress(selected.size(),published,Map.copyOf(failures),true);
            }
        } finally {
            progress=new Progress(selected.size(),published,Map.copyOf(failures),false);
        }
    }
}
