package com.englishcoach.wordchain;

import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class WordChainServiceTest {
    static class Time extends Clock {
        long ms=100000;
        public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId z){return this;}
        public Instant instant(){return Instant.ofEpochMilli(ms);}public long millis(){return ms;}
    }
    WordChainLexicon lex; WordChainResults results; WordChainService game; Time time;
    @BeforeEach void setUp() {
        lex=mock(WordChainLexicon.class);results=mock(WordChainResults.class);time=new Time();
        when(lex.available()).thenReturn(true);
        for(String word:List.of("echo","orange","energy","ye","eye","eagle","earth","hello","owl","lake"))
            when(lex.check(word)).thenReturn(new WordChainLexicon.Verdict(new WordChainLexicon.Word(word,word,null,"noun",word,null,List.of()),null));
        game=new WordChainService(lex,results,mock(SimpMessagingTemplate.class),time,Runnable::run);game.startLetter=()->'o';
    }
    @AfterEach void close(){game.close();}
    Map<String,Object> act(long user,String session,String action,String room,String mode,String word,Long revision,String message) {
        return game.act(user,"Player "+user,"principal-"+user,session,
                new WordChainService.Command(action,room,mode,"STANDARD",word,message,revision,null));
    }
    Map<String,Object> act(long user,String action,String room) {return act(user,"s"+user,action,room,null,null,null,null);}
    Map<String,Object> submit(long user,Map<String,Object>s,String word,String id) {
        time.ms+=1000;
        return act(user,"s"+user,"submit",(String)s.get("roomCode"),null,word,(Long)s.get("revision"),id);
    }
    Map<String,Object> pvp() {
        var s=act(1,"create",null);String room=(String)s.get("roomCode");act(2,"join",room);act(1,"ready",room);return act(2,"ready",room);
    }
    @Test void soloResultInvalidDuplicateAndIdempotency() {
        var s=act(1,"s1","start",null,"SOLO",null,null,null);assertEquals("ACTIVE",s.get("status"));
        assertEquals("WRONG_LETTER",assertThrows(WordChainRules.Rejection.class,()->submit(1,s,"energy","bad")).code);
        var a=submit(1,s,"orange","a");assertEquals(1,a.get("acceptedCount"));
        var replay=submit(1,s,"orange","a");assertEquals(1,replay.get("acceptedCount"));
        var b=submit(1,a,"energy","b");var c=submit(1,b,"ye","c");
        assertEquals("SELF_DUPLICATE",assertThrows(WordChainRules.Rejection.class,()->submit(1,c,"energy","dup")).code);
        var end=act(1,"give-up",(String)s.get("roomCode"));assertEquals("FINISHED",end.get("status"));assertEquals(3,end.get("acceptedCount"));
        verify(results).save(any(),eq("SOLO"),anyMap(),any());
    }
    @Test void fullPvpDuplicateChainOwnershipAndRematch() {
        var s=pvp();var initial=s;assertEquals(1L,s.get("turnPlayerId"));
        assertEquals("NOT_YOUR_TURN",assertThrows(WordChainRules.Rejection.class,()->submit(2,initial,"orange","out")).code);
        assertEquals("NOT_A_MEMBER",assertThrows(WordChainRules.Rejection.class,()->submit(3,initial,"orange","cross")).code);
        s=submit(1,s,"orange","1");s=submit(2,s,"eye","2");s=submit(1,s,"energy","3");
        s=submit(2,s,"ye","4");s=submit(1,s,"eagle","5");s=submit(2,s,"energy","6");
        s=submit(1,s,"ye","7");s=submit(2,s,"eagle","8");var a=s;
        assertEquals("SELF_DUPLICATE",assertThrows(WordChainRules.Rejection.class,()->submit(1,a,"energy","d1")).code);
        s=submit(1,s,"earth","9");s=submit(2,s,"hello","10");s=submit(1,s,"owl","11");s=submit(2,s,"lake","12");
        s=submit(1,s,"echo","13");s=submit(2,s,"orange","14");s=submit(1,s,"eye","15");var b=s;
        assertEquals("SELF_DUPLICATE",assertThrows(WordChainRules.Rejection.class,()->submit(2,b,"energy","d2")).code);
        verify(lex,times(1)).check("energy");
        String room=(String)s.get("roomCode");act(1,"give-up",room);act(1,"rematch",room);
        assertEquals("ACTIVE",act(2,"rematch",room).get("status"));
    }
    @Test void timeoutStaleTurnDisconnectAndRejoin() {
        var s=pvp();String room=(String)s.get("roomCode");
        var next=submit(1,s,"orange","a");
        assertEquals("STALE_TURN",assertThrows(WordChainRules.Rejection.class,()->submit(2,s,"energy","stale")).code);
        game.disconnect("s2");time.ms+=14000;
        var rejoined=act(2,"new2","rejoin",room,null,null,null,null);assertEquals("ACTIVE",rejoined.get("status"));
        assertEquals("STALE_SESSION",assertThrows(WordChainRules.Rejection.class,()->submit(2,rejoined,"energy","old")).code);
        time.ms+=16001;game.tick();assertEquals("FINISHED",act(2,"ping",room).get("status"));
        var rematch1=act(1,"rematch",room);assertEquals("FINISHED",rematch1.get("status"));
        var rematch2=act(2,"new2","rematch",room,null,null,null,null);assertEquals("ACTIVE",rematch2.get("status"));assertNotEquals(s.get("matchId"),rematch2.get("matchId"));
        game.disconnect("new2");time.ms+=15001;game.tick();assertEquals("DISCONNECT",act(1,"ping",room).get("endReason"));
    }
    @Test void quickMatchesDifferentUsersAndLeaveCancelsWaiting() {
        var a=act(1,"quick",null);var b=act(2,"quick",null);assertEquals(a.get("roomCode"),b.get("roomCode"));
        var c=act(3,"quick",null);assertNotEquals(a.get("roomCode"),c.get("roomCode"));act(3,"leave",(String)c.get("roomCode"));
        assertEquals("ROOM_NOT_FOUND",assertThrows(WordChainRules.Rejection.class,()->act(3,"rejoin",(String)c.get("roomCode"))).code);
    }
    @Test void dictionaryUnavailableDoesNotCreateGame() {
        when(lex.available()).thenReturn(false);
        assertEquals("DICTIONARY_UNAVAILABLE",assertThrows(WordChainRules.Rejection.class,()->act(1,"create",null)).code);
    }
    @Test void leftPlayerCannotRejoinOldRoomOrRematchAgainstGoneOpponent() {
        var s=pvp();String old=(String)s.get("roomCode");act(1,"give-up",old);act(2,"leave",old);
        var fresh=act(2,"create",null);assertNotEquals(old,fresh.get("roomCode"));
        assertEquals("NOT_A_MEMBER",assertThrows(WordChainRules.Rejection.class,()->act(2,"rejoin",old)).code);
        assertEquals("OPPONENT_LEFT",assertThrows(WordChainRules.Rejection.class,()->act(1,"rematch",old)).code);
    }
    @Test void deadlineCannotBeExtendedByRejectedWordsOrLateSubmit() {
        var s=act(1,"s1","start",null,"SOLO",null,null,null);long deadline=(Long)s.get("deadline");
        assertThrows(WordChainRules.Rejection.class,()->submit(1,s,"zzzzz","wrong"));
        assertEquals(deadline,act(1,"ping",(String)s.get("roomCode")).get("deadline"));
        time.ms=deadline;
        assertEquals("NOT_ACTIVE",assertThrows(WordChainRules.Rejection.class,()->submit(1,s,"orange","late")).code);
        assertEquals(0,act(1,"ping",(String)s.get("roomCode")).get("acceptedCount"));
    }
    @Test void botObeysLetterAndOwnDuplicateSet() {
        when(lex.botWords()).thenReturn(Map.of('e',List.of(new WordChainLexicon.BotWord("eagle",1),new WordChainLexicon.BotWord("eye",1))));
        var s=act(1,"s1","start",null,"BOT",null,null,null);assertEquals("o",s.get("requiredLetter"));assertNull(s.get("currentWord"));
        s=submit(1,s,"orange","1");time.ms+=3300;game.tick();
        s=act(1,"ping",(String)s.get("roomCode"));String first=((WordChainLexicon.Word)s.get("currentWord")).normalizedWord();
        assertTrue(Set.of("eagle","eye").contains(first));assertEquals("e",s.get("requiredLetter"));
        s=submit(1,s,"eagle","2");time.ms+=3300;game.tick();
        s=act(1,"ping",(String)s.get("roomCode"));String second=((WordChainLexicon.Word)s.get("currentWord")).normalizedWord();
        assertNotEquals(first,second);assertTrue(Set.of("eagle","eye").contains(second));
        s=submit(1,s,"energy","3");time.ms+=3300;game.tick();assertEquals("BOT_NO_WORD",act(1,"ping",(String)s.get("roomCode")).get("endReason"));
    }
    @Test void startLetterIsUniformOverTheWholeAlphabet() {
        var real=new WordChainService(lex,results,mock(SimpMessagingTemplate.class),time,Runnable::run);
        try {
            Map<Character,Integer> seen=new TreeMap<>();
            for(int i=0;i<2600;i++){char c=(char)real.startLetter.getAsInt();seen.merge(c,1,Integer::sum);}
            assertEquals(26,seen.size());assertTrue(seen.keySet().stream().allMatch(c->c>='a'&&c<='z'));
            assertTrue(seen.values().stream().allMatch(n->n>40 && n<180),seen.toString());
            Set<String> letters=new HashSet<>();
            for(long u=1;u<=40;u++){letters.add((String)real.act(u,"P","p"+u,"s"+u,new WordChainService.Command("start",null,"SOLO","STANDARD",null,null,null,null)).get("startLetter"));}
            assertTrue(letters.size()>8,"independent letters per match: "+letters);
        } finally { real.close(); }
    }
    @Test void rivalReconnectDoesNotVoidAWordOfTheCurrentTurn() {
        var s=pvp();String room=(String)s.get("roomCode");
        game.disconnect("s2");act(2,"s2b","rejoin",room,null,null,null,null);
        assertEquals(1,submit(1,s,"orange","r1").get("acceptedCount"));
    }
    @Test void startNewGameWhenPreviousFinished() {
        var s=act(1,"s1","start",null,"SOLO",null,null,null);
        act(1,"give-up",(String)s.get("roomCode"));
        // User starts a new match without leaving old finished room
        var fresh=act(1,"s1","start",null,"SOLO",null,null,null);
        assertEquals("ACTIVE",fresh.get("status"));
        assertNotEquals(s.get("roomCode"),fresh.get("roomCode"));
    }
}
