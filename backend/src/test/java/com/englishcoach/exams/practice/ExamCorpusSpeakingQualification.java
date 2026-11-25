package com.englishcoach.exams.practice;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.LocalExamObjectStorage;
import com.englishcoach.exams.model.ExamMediaRecords.*;
import com.englishcoach.exams.model.ExamSpeakingRecords.*;
import com.englishcoach.exams.model.ExamTypes.RecordingState;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.service.ExamSpeakingRuntimeService;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.*;
import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Synthetic local recording transport qualification; production microphone sampling remains separate. */
final class ExamCorpusSpeakingQualification {
    @SuppressWarnings("unchecked")
    static void qualify(UUID form, String scope) throws Exception {
        UUID id=practice.createPracticeAttempt(LEARNER,new ExamPracticeRecords.CreatePracticeAttemptRequest(form,scope,null)).attemptId();
        start(id,LEARNER);
        var speaking=new ExamSpeakingRuntimeService(attemptRepository,contentRepository);
        var props=new ExamsProperties();
        props.getStorage().getLocal().setBaseDir(Files.createTempDirectory("corpus-speaking-").toString());
        var storage=new LocalExamObjectStorage(props);
        var mediaRepository=new com.englishcoach.exams.repository.ExamMediaRepository(named,MAPPER);
        var rights=ExamRightsService.ownerAuthorizedLocalRuntime(contentRepository,mediaRepository,props);
        var transport=new ExamMediaService(mediaRepository,attemptRepository,rights,storage);
        var state=speaking.getOrInitializeSpeakingState(LEARNER,id);
        int part=Integer.parseInt(scope.substring(scope.lastIndexOf('_')+1));
        int total=com.englishcoach.exams.service.ExamPinnedSpeakingPrompts.requiredTurns(attempt(id).manifestSnapshot(),part,part==2?1:4);
        assertEquals(total,state.totalTurns());
        List<Map<String,Object>> expected=new ArrayList<>();
        for(var section:(List<Map<String,Object>>)attempt(id).manifestSnapshot().get("sections"))
            for(var sourcePart:(List<Map<String,Object>>)section.get("parts"))
                if(("SPEAKING_PART_"+part).equals(sourcePart.get("partCode")))
                    for(var group:(List<Map<String,Object>>)sourcePart.get("groups"))
                        expected.addAll((List<Map<String,Object>>)group.get("items"));
        assertEquals(total,expected.size());
        byte[] audio=tone();
        String hash=ExamMediaService.computeSha256(audio);
        List<UUID> recordings=new ArrayList<>();
        while(!state.sectionCompleted()) {
            var turn=state.currentTurn();
            assertNotNull(turn); assertNotNull(turn.prompt()); assertFalse(turn.prompt().isBlank());
            assertEquals(expected.get(recordings.size()).get("prompt"),turn.prompt());
            assertEquals(UUID.fromString((String)expected.get(recordings.size()).get("id")),turn.itemId());
            String mutation=UUID.nameUUIDFromBytes((id+":"+turn.turnKey()).getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
            if(scope.endsWith("_2")) state=speaking.startPreparation(LEARNER,id,new StartPreparationCommand(mutation+"-prepare",state.turnRevision(),turn.turnKey(),state.transitionToken()));
            state=speaking.startRecording(LEARNER,id,new StartRecordingCommand(mutation+"-start",state.turnRevision(),turn.turnKey(),state.transitionToken()));
            var rec=transport.initiateRecording(LEARNER,id,new InitiateRecordingRequest(id,turn.placementId(),"audio/wav",Map.of("syntheticQualification",true),turn.turnKey(),mutation+"-init",attempt(id).revision()));
            transport.saveChunk(LEARNER,rec.recordingId(),0,hash,audio);
            state=speaking.stopRecording(LEARNER,id,new StopRecordingCommand(mutation+"-stop",state.turnRevision(),turn.turnKey(),state.transitionToken()));
            var seal=new SealRecordingRequest(List.of(new ChunkManifestItem(0,hash,audio.length)),(long)audio.length,hash,1,hash,mutation+"-seal");
            assertEquals(RecordingState.SEALED,transport.sealRecording(LEARNER,rec.recordingId(),seal).state());
            assertEquals(RecordingState.SEALED,transport.sealRecording(LEARNER,rec.recordingId(),seal).state());
            assertArrayEquals(audio,transport.getRecordingAudioData(LEARNER,rec.recordingId(),null,false).data());
            state=speaking.completeTurn(LEARNER,id,new CompleteTurnCommand(mutation+"-complete",state.turnRevision(),rec.recordingId(),1000,turn.turnKey(),state.transitionToken()));
            recordings.add(rec.recordingId());
            assertTrue(recordings.size()<=total);
        }
        assertEquals(total,recordings.size());
        var command=new com.englishcoach.exams.model.ExamAttemptRecords.SubmitAttemptRequest("submit-"+id,
                attempt(id).revision(),com.englishcoach.exams.model.ExamTypes.SubmissionReason.MANUAL,List.of());
        UUID submission=responses.submitAttempt(LEARNER,id,command);
        assertEquals(submission,responses.submitAttempt(LEARNER,id,command));
        var result=practice.getResult(LEARNER,id);
        assertEquals("SUBMITTED",result.completionStatus());
        assertFalse(result.standardizedScoreAvailable());
        assertEquals(result,practice.getResult(LEARNER,id));
        assertFalse(practice.getReview(LEARNER,id).groups().isEmpty());
        var reviewService=new com.englishcoach.exams.service.ExamResultService(attemptRepository,scoringRepository,
                contentRepository,mediaRepository,transport,new com.englishcoach.exams.scoring.ExamObjectiveScorer(new com.englishcoach.exams.scoring.ExamAnswerNormalizer()));
        var review=reviewService.getAttemptReview(id,LEARNER,false).speakingReview();
        assertNotNull(review);
        assertEquals(total,review.turns().size());
        assertEquals(expected.stream().map(i->i.get("prompt")).toList(),review.turns().stream().map(t->t.promptText()).toList());
        assertEquals(recordings,review.turns().stream().map(t->t.recordingId()).toList());
        assertEquals(total,transport.findRecordingsByAttemptId(id).size());
        for(UUID recording:recordings) {
            assertEquals(RecordingState.SEALED,transport.findRecordingById(recording).orElseThrow().state());
            assertArrayEquals(audio,transport.getRecordingAudioData(LEARNER,recording,null,false).data());
        }
        assertTrue(scoringRepository.findComponentsByArtifactId(scoringRepository.findLatestArtifactBySubmissionId(submission).orElseThrow().id()).isEmpty());
    }
    private static byte[] tone() {
        int samples=16000;
        ByteBuffer wav=ByteBuffer.allocate(44+samples*2).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(36+samples*2);
        wav.put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16).putShort((short)1).putShort((short)1);
        wav.putInt(samples).putInt(samples*2).putShort((short)2).putShort((short)16);
        wav.put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(samples*2);
        for(int i=0;i<samples;i++)wav.putShort((short)(1200*Math.sin(i*2*Math.PI*440/samples)));
        return wav.array();
    }
}
