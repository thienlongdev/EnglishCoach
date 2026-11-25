package com.englishcoach.spelling;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.spelling.SpellingRules.*;

class SpellingMatchTest {
    long now=100000;
    SpellingMatch match(Mode mode,int count){
        var r=new SpellingMatch("ROOM1234",mode,Difficulty.EASY,count,false,now,(tier,used)->
            new SpellingCatalog.Word("ocean",tier,"local-test","",new SpellingCatalog.Clip("opaque.wav",1000,"hash")));
        for(int i=1;i<=count;i++){var m=new SpellingMatch.Member(i,"Learner "+i,"LYRA","","s"+i,now,i-1);m.ready=true;r.add(m);}
        r.start(now);now=r.deadline+1;r.tick(now,100);now=r.deadline+1;r.tick(now,100);
        return r;
    }
    void hear(SpellingMatch r){r.delivered(r.active,r.turnId,now);now+=1001;r.heard(r.active,r.turnId,now);}
    @Test void timerStartsOnlyAfterDeliveredAudioFinishes(){var r=match(Mode.ENDLESS,1);
        assertEquals(Phase.HEAR,r.phase);assertEquals(0,r.answerDeadline);
        assertThrows(IllegalArgumentException.class,()->r.heard(r.active,r.turnId,now));
        r.delivered(r.active,r.turnId,now);assertThrows(IllegalArgumentException.class,()->r.heard(r.active,r.turnId,now));
        now+=1001;r.heard(r.active,r.turnId,now);assertEquals(now+15000,r.answerDeadline);
    }
    @Test void exactSpellingFinishesWithoutEnterAndCannotScoreTwice(){var r=match(Mode.ENDLESS,1);hear(r);now+=900;
        r.draft(r.active,r.turnId,1,"oce",now,false);assertEquals(Phase.SPELL,r.phase);
        r.draft(r.active,r.turnId,2,"ocean",now,false);assertEquals(Phase.RESULT,r.phase);assertEquals(1,r.active.correct);
        assertThrows(IllegalArgumentException.class,()->r.draft(r.active,r.turnId,3,"ocean",now,true));assertEquals(1,r.reviews.size());
    }
    @Test void incorrectPartialNeverEliminatesUntilCommitted(){var r=match(Mode.ENDLESS,1);hear(r);
        r.draft(r.active,r.turnId,1,"oceam",now+600,false);assertFalse(r.active.eliminated);
        r.draft(r.active,r.turnId,2,"oce",now+700,false);r.draft(r.active,r.turnId,3,"ocean",now+800,true);assertEquals(1,r.active.correct);
    }
    @Test void serverDeadlineWinsEvenWhenBrowserSendsLateCorrectAnswer(){var r=match(Mode.ENDLESS,1);hear(r);
        r.draft(r.active,r.turnId,1,"ocean",r.answerDeadline+1,true);assertEquals(0,r.active.correct);assertEquals(1,r.active.wrong);assertEquals(Phase.FINISHED,r.phase);
    }
    @Test void otherPlayerAndOldTurnCannotSubmit(){var r=match(Mode.MULTIPLAYER,2);hear(r);
        var other=r.members.get(2L);assertThrows(IllegalArgumentException.class,()->r.draft(other,r.turnId,1,"ocean",now+1000,true));
        assertThrows(IllegalArgumentException.class,()->r.draft(r.active,UUID.randomUUID(),1,"ocean",now+1000,true));
    }
    @Test void wrongAnswerEliminatesAndLastSurvivorWins(){var r=match(Mode.MULTIPLAYER,2);hear(r);
        r.draft(r.active,r.turnId,1,"oceanx",now+1000,true);assertTrue(r.active.eliminated);
        now=r.deadline+1;r.tick(now,100);assertEquals(Phase.FINISHED,r.phase);assertEquals("2",r.winner);
    }
    @Test void correctAnswerPassesMicrophoneToNextIndependentPlayer(){var r=match(Mode.MULTIPLAYER,2);hear(r);
        r.draft(r.active,r.turnId,1,"ocean",now+1000,true);now=r.deadline+1;r.tick(now,100);
        assertEquals("2",r.active.id);assertEquals(Phase.APPROACH,r.phase);assertEquals(0,r.active.correct);
    }
    @Test void sprintSurvivesMistakeAndEndsAtFixedDeadline(){var r=match(Mode.SPRINT,1);hear(r);long end=r.sprintDeadline;
        r.draft(r.active,r.turnId,1,"bad",now+1000,true);assertFalse(r.active.eliminated);
        r.tick(end+1,100);assertEquals(Phase.FINISHED,r.phase);assertEquals(end,r.sprintDeadline);
    }
    @Test void practiceNeverTimesOutAndKeepsMistakeReview(){var r=match(Mode.PRACTICE,1);hear(r);
        r.tick(now+60000,100);assertEquals(Phase.SPELL,r.phase);assertEquals(0,r.answerDeadline);
        r.draft(r.active,r.turnId,1,"bad",now+61000,true);assertFalse(r.active.eliminated);assertEquals(1,r.reviews.size());
    }
    @Test void failedAudioDoesNotCreateWrongAnswerOrWinner(){var r=match(Mode.MULTIPLAYER,2);
        r.tick(r.deadline+1,100);assertEquals(Phase.ABORTED,r.phase);assertNull(r.winner);assertEquals(0,r.active.wrong);
    }
    @Test void repeatedAudioNeverResetsClockAndIsBounded(){var r=match(Mode.ENDLESS,1);hear(r);long end=r.answerDeadline;
        r.repeat(r.active,r.turnId,now+2000);r.repeat(r.active,r.turnId,now+4000);
        assertThrows(IllegalArgumentException.class,()->r.repeat(r.active,r.turnId,now+6000));assertEquals(end,r.answerDeadline);
    }
    @Test void staleDraftCannotOverwriteNewerBackspace(){var r=match(Mode.PRACTICE,1);hear(r);
        r.draft(r.active,r.turnId,4,"oce",now+400,false);r.draft(r.active,r.turnId,3,"oceam",now+500,false);assertEquals("oce",r.typed);
    }
    @Test void projectionsDoNotExposeWordUntilResult(){var r=match(Mode.ENDLESS,1);hear(r);
        assertNull(r.state(r.active,now).result());assertTrue(r.state(r.active,now).review().isEmpty());
        assertFalse(r.state(r.active,now).turn().audioUrl().contains("ocean"));
    }
    @Test void speedBudgetDoesNotGrowWithPacketFrequency(){var r=match(Mode.MULTIPLAYER,2);var m=r.members.get(2L);double x=m.x,z=m.z;
        for(int i=0;i<1000;i++)r.move(m,10,10,0,i,false,now);
        assertTrue(Math.hypot(m.x-x,m.z-z)<=1.601);
    }
    @Test void difficultyAndMetricsAreExplicit(){assertEquals(2,tier(Difficulty.EASY,Mode.ENDLESS,6,1));assertEquals(0,tier(Difficulty.EASY,Mode.PRACTICE,90,1));assertEquals(60,wpm(5,1000));assertEquals(75,accuracy(3,1));}
    @Test void uncluedHomophonesAndStandardSpellingVariantsAreFair(){assertTrue(accepts("bread","bred"));assertTrue(accepts("lesson","lessen"));assertTrue(accepts("yogurt","yoghurt"));assertTrue(accepts("coconut","cocoanut"));assertFalse(accepts("flower","flour"),"recording explicitly says blossom");assertFalse(accepts("morning","mourning"),"recording explicitly says early part of day");}
}
