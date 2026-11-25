package com.englishcoach.quizrush;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RushCompetitiveSecurityTest {
    @Test @SuppressWarnings("unchecked") void projectionsShareQuestionButKeepPrivateBalancedAnswers()throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        var service=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),new RushCompetitivePersistenceTest.Time());var one=RushCompetitivePersistenceTest.act(service,1,"create",null);
        service.act(2,"fixture2","socket2","join",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),null,(String)one.get("invitation"),null,null,null,null,null,null));
        RushCompetitivePersistenceTest.act(service,1,"ready",one);RushCompetitivePersistenceTest.act(service,2,"ready",one);RushCompetitivePersistenceTest.act(service,1,"start",one);
        var first=service.get(1,(UUID)one.get("roomId"));var second=service.get(2,(UUID)one.get("roomId"));var q1=(RushDtos.Question)first.get("question");var q2=(RushDtos.Question)second.get("question");
        assertEquals(q1.id(),q2.id());assertEquals(q1.options().stream().map(RushDtos.Option::id).collect(java.util.stream.Collectors.toSet()),q2.options().stream().map(RushDtos.Option::id).collect(java.util.stream.Collectors.toSet()));
        int correct1=java.util.stream.IntStream.range(0,q1.options().size()).filter(i->q1.options().get(i).label().equals("right")).findFirst().orElseThrow();int correct2=java.util.stream.IntStream.range(0,q2.options().size()).filter(i->q2.options().get(i).label().equals("right")).findFirst().orElseThrow();assertNotEquals(correct1,correct2);
        for(var player:(List<Map<String,Object>>)first.get("players")){assertFalse(player.containsKey("openGate"));assertFalse(player.containsKey("selected"));assertFalse(player.containsKey("rejected"));assertFalse(player.containsKey("orders"));}
        assertFalse(first.containsKey("answerId"));assertFalse(second.containsKey("answerId"));service.close();
    }
    @Test void expiringOlderTerminalRoomPreservesNewerTerminalRoomSocket()throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        var time=new RushCompetitivePersistenceTest.Time();var service=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time);
        var old=RushCompetitivePersistenceTest.act(service,1,"quick",null);time.ms+=90001;service.tick(.05);assertEquals("CANCELED",service.get(1,(UUID)old.get("roomId")).get("status"));
        time.ms+=60000;var newer=RushCompetitivePersistenceTest.act(service,1,"quick",null);time.ms+=90001;service.tick(.05);assertEquals("CANCELED",service.get(1,(UUID)newer.get("roomId")).get("status"));
        // The next tick evicts the older room while the new room has released membership.
        time.ms+=1;service.tick(.05);assertEquals(Map.of("left",true),RushCompetitivePersistenceTest.act(service,1,"leave",newer));service.close();
    }
    @Test void privateGuardRejectsForgeryPublicQueuesOversizeAndUnknownActions(){
        for(String destination:List.of("/topic/quiz-rush/room","/queue/quiz-rush-other","/user/fixture2/queue/quiz-rush")){var h=StompHeaderAccessor.create(StompCommand.SUBSCRIBE);h.setDestination(destination);h.setUser(new UsernamePasswordAuthenticationToken("fixture1",""));assertThrows(IllegalArgumentException.class,()->RushCompetitiveChannelGuard.validate(MessageBuilder.createMessage(new byte[0],h.getMessageHeaders())));}
        for(String destination:List.of("/app/quiz-rush/teleport","/queue/quiz-rush")){var h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination(destination);h.setUser(new UsernamePasswordAuthenticationToken("fixture1",""));assertThrows(IllegalArgumentException.class,()->RushCompetitiveChannelGuard.validate(MessageBuilder.createMessage(new byte[0],h.getMessageHeaders())));}
        var h=StompHeaderAccessor.create(StompCommand.SEND);h.setLeaveMutable(true);h.setDestination("/app/quiz-rush/input");assertThrows(IllegalArgumentException.class,()->RushCompetitiveChannelGuard.validate(MessageBuilder.createMessage(new byte[0],h.getMessageHeaders())));h.setUser(new UsernamePasswordAuthenticationToken("fixture1",""));assertThrows(IllegalArgumentException.class,()->RushCompetitiveChannelGuard.validate(MessageBuilder.createMessage(new byte[2049],h.getMessageHeaders())));assertNotNull(RushCompetitiveChannelGuard.validate(MessageBuilder.createMessage(new byte[2048],h.getMessageHeaders())));
    }
    @Test @SuppressWarnings("unchecked") void queueExpirySocketReplacementRollbackAndRoomMembership()throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));when(repo.decode(anyString())).thenAnswer(i->json.readValue((String)i.getArgument(0),RushCompetitiveService.Room.class));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        var time=new RushCompetitivePersistenceTest.Time();var service=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time);
        var first=RushCompetitivePersistenceTest.act(service,1,"quick",null);assertEquals(first.get("roomId"),RushCompetitivePersistenceTest.act(service,2,"quick",null).get("roomId"));time.ms+=10001;service.tick(.05);var started=service.get(1,(UUID)first.get("roomId"));assertEquals("COUNTDOWN",started.get("status"));
        service.act(1,"fixture1","replacement","rejoin",RushCompetitivePersistenceTest.command(started,UUID.randomUUID(),null,null,null,null,null,null));service.disconnect("socket1");var projected=service.get(1,(UUID)first.get("roomId"));assertEquals(true,((List<Map<String,Object>>)projected.get("players")).getFirst().get("connected"));assertThrows(RushException.class,()->RushCompetitivePersistenceTest.act(service,1,"leave",projected));
        service.act(1,"fixture1","replacement","leave",RushCompetitivePersistenceTest.command(projected,UUID.randomUUID(),null,null,null,null,null,null));RushCompetitivePersistenceTest.act(service,2,"leave",started);
        var queue=RushCompetitivePersistenceTest.act(service,1,"quick",null);time.ms+=90001;service.tick(.05);assertEquals("CANCELED",service.get(1,(UUID)queue.get("roomId")).get("status"));
        var privateRoom=RushCompetitivePersistenceTest.act(service,1,"create",null);UUID roomId=(UUID)privateRoom.get("roomId");doThrow(new IllegalStateException("fixture storage unavailable")).when(repo).write(any());time.ms+=5001;service.tick(.1);assertEquals("PERSISTENCE_UNAVAILABLE",service.get(1,roomId).get("recovery"));assertThrows(RushException.class,()->RushCompetitivePersistenceTest.act(service,1,"ready",privateRoom));doNothing().when(repo).write(any());time.ms+=1001;service.tick(.1);assertEquals("",service.get(1,roomId).get("recovery"));RushCompetitivePersistenceTest.act(service,1,"leave",privateRoom);
        time.ms+=1001;var lobby=RushCompetitivePersistenceTest.act(service,1,"create",null);service.act(2,"fixture2","socket2","join",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),null,(String)lobby.get("invitation"),null,null,null,null,null,null));service.act(1,"fixture1","socket1","kick",RushCompetitivePersistenceTest.command(lobby,UUID.randomUUID(),null,"p2",null,null,null,null));assertThrows(RushException.class,()->service.get(2,(UUID)lobby.get("roomId")));time.ms+=900001;service.tick(.05);assertEquals("ROOM_EXPIRED",service.get(1,(UUID)lobby.get("roomId")).get("reason"));
        time.ms+=1001;var flood=RushCompetitivePersistenceTest.act(service,1,"create",null);for(int i=0;i<23;i++)RushCompetitivePersistenceTest.act(service,1,"ping",flood);assertThrows(RushException.class,()->RushCompetitivePersistenceTest.act(service,1,"ping",flood));service.close();
    }
    @Test void receiptBudgetIsPerRacerAndLargeSnapshotsStayBounded()throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));when(repo.decode(anyString())).thenAnswer(i->json.readValue((String)i.getArgument(0),RushCompetitiveService.Room.class));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        var time=new RushCompetitivePersistenceTest.Time();var service=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time);var room=RushCompetitivePersistenceTest.act(service,1,"create",null);for(int user=2;user<=5;user++)service.act(user,"fixture"+user,"socket"+user,"join",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),null,(String)room.get("invitation"),null,null,null,null,null,null));
        for(int i=0;i<200;i++){time.ms+=100;for(int user=1;user<=5;user++)RushCompetitivePersistenceTest.act(service,user,"ready",room);}assertEquals("COUNTDOWN",RushCompetitivePersistenceTest.act(service,1,"start",room).get("status"));
        var capture=org.mockito.ArgumentCaptor.forClass(RushCompetitiveRepository.Stored.class);verify(repo,atLeastOnce()).write(capture.capture());var saved=json.readValue(capture.getValue().snapshot(),RushCompetitiveService.Room.class);assertTrue(saved.receipts.size()>1000);assertTrue(json.writeValueAsBytes(saved).length<900000);assertTrue(saved.receipts.values().stream().allMatch(r->r.command().matches("[a-f0-9]{64}")));service.close();
    }

}
