package com.englishcoach.quizrush;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Short private-room codes and the cosmetic hero allow-list (2026-10-29). */
class RushRoomCodeHeroTest {
    private static RushCompetitiveService service(RushCompetitivePersistenceTest.Time time)throws Exception{
        var json=new ObjectMapper();var repo=mock(RushCompetitiveRepository.class);when(repo.recover()).thenReturn(List.of());when(repo.encode(any())).thenAnswer(i->json.writeValueAsString(i.getArgument(0)));
        when(repo.decode(anyString())).thenAnswer(i->json.readValue((String)i.getArgument(0),RushCompetitiveService.Room.class));
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        return new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time);
    }
    private static RushCompetitiveService.Command cmd(Map<String,Object> s,String invitation,String hero){
        return new RushCompetitiveService.Command(s==null?null:(UUID)s.get("roomId"),s==null?null:(UUID)s.get("matchId"),UUID.randomUUID(),RushCompetitivePersistenceTest.SETUP,invitation,null,null,null,null,null,null,hero);
    }
    @SuppressWarnings("unchecked")
    private static String heroOf(Map<String,Object> view,String id){return (String)((List<Map<String,Object>>)view.get("players")).stream().filter(p->p.get("id").equals(id)).findFirst().orElseThrow().get("hero");}

    @Test void codeJoinsTheSameRoomAsTheInvitationCaseAndSeparatorsIgnored()throws Exception{
        var time=new RushCompetitivePersistenceTest.Time();var service=service(time);
        var room=service.act(1,"fixture1","socket1","create",cmd(null,null,"KAI"));
        String code=(String)room.get("code");
        assertTrue(code.matches("[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}"),code);
        assertEquals("KAI",heroOf(room,"p1"));
        String typed=code.substring(0,3).toLowerCase()+" - "+code.substring(3).toLowerCase();
        var joined=service.act(2,"fixture2","socket2","join",cmd(null,typed,"LYRA"));
        assertEquals(room.get("roomId"),joined.get("roomId"));
        assertEquals("LYRA",heroOf(joined,"p2"));assertEquals("KAI",heroOf(joined,"p1"));
        // The long invitation link keeps working.
        var third=service.act(3,"fixture3","socket3","join",cmd(null,(String)room.get("invitation"),null));
        assertEquals(room.get("roomId"),third.get("roomId"));assertEquals("LYRA",heroOf(third,"p3"));
        service.close();
    }
    @Test void unknownMalformedStartedAndExpiredCodesAreTheSame404()throws Exception{
        var time=new RushCompetitivePersistenceTest.Time();var service=service(time);
        var room=service.act(1,"fixture1","socket1","create",cmd(null,null,null));String code=(String)room.get("code");
        String other=code.equals("AAAAAA")?"BBBBBB":"AAAAAA";
        for(String bad:new String[]{other,"ABC","O0O0O0","ABCDEFG",""}){
            var e=assertThrows(RushException.class,()->service.act(2,"fixture2","socket2","join",cmd(null,bad,null)));assertEquals("ROOM_NOT_FOUND",e.getMessage());
        }
        time.ms+=900001;
        var e=assertThrows(RushException.class,()->service.act(3,"fixture3","socket3","join",cmd(null,code,null)));assertEquals("ROOM_NOT_FOUND",e.getMessage());
        service.close();
    }
    @Test void heroIsAllowListedCopiedToRematchAndBotsMixBothHeroes()throws Exception{
        var time=new RushCompetitivePersistenceTest.Time();var service=service(time);
        var room=service.act(1,"fixture1","socket1","bots",cmd(null,null,"<script>"));
        assertEquals("LYRA",heroOf(room,"p1"));
        var heroes=new HashSet<String>();for(int i=2;i<=5;i++)heroes.add(heroOf(room,"p"+i));
        assertEquals(Set.of("LYRA","KAI"),heroes);
        assertEquals("",room.get("code"));
        service.close();
    }
    @Test void rejoinBeforeTheRaceUpdatesTheHero()throws Exception{
        var time=new RushCompetitivePersistenceTest.Time();var service=service(time);
        var room=service.act(1,"fixture1","socket1","create",cmd(null,null,"LYRA"));
        var again=service.act(1,"fixture1","socket1b","rejoin",cmd(room,null,"KAI"));
        assertEquals("KAI",heroOf(again,"p1"));
        service.close();
    }
}
