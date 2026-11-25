package com.englishcoach.hangman;

import java.util.*;
import java.util.random.RandomGenerator;

/** Pure state transitions. Animation and client claims never decide game state. */
public final class HangmanRules {
    private HangmanRules() {}
    public enum Difficulty { EASY(2,8), MEDIUM(1,7), HARD(0,6); public final int prefill, balloons; Difficulty(int p,int b){prefill=p;balloons=b;} }
    public enum Status { ACTIVE, WON, LOST }
    public record State(String answer,Difficulty difficulty,String prefilled,String guessed,String hinted,int remaining,Status status,int version) {
        public String visible(){return prefilled+guessed+hinted;}
        public boolean used(char c){return visible().indexOf(c)>=0;}
        public List<String> pattern(){var result=new ArrayList<String>();for(char c:answer.toCharArray())result.add(visible().indexOf(c)>=0?String.valueOf(c):null);return result;}
        public int score(){return status==Status.WON?Math.max(0,100+10*remaining-20*hinted.length()):0;}
        /** V76 persists each unique wrong guess and remaining budget. This is
         * invariant through correct guesses/hints and preserves legacy 10/9/8. */
        public int initialBalloons(){return remaining+(int)guessed.chars().filter(c->answer.indexOf(c)<0).count();}
    }
    public record Transition(State state,boolean changed) {}
    public static List<Character> distinctLetters(String answer){if(answer==null||!answer.matches("[A-Z]{4,10}"))throw new IllegalArgumentException("INVALID_WORD");var values=new ArrayList<Character>();for(char c:answer.toCharArray())if(!values.contains(c))values.add(c);return values;}
    public static State start(String answer,Difficulty difficulty,RandomGenerator random){var values=distinctLetters(answer);if(values.size()<=difficulty.prefill)throw new IllegalArgumentException("INSUFFICIENT_LETTERS");var selected=new StringBuilder();for(int i=0;i<difficulty.prefill;i++)selected.append(values.remove(random.nextInt(values.size())));return new State(answer,difficulty,selected.toString(),"","",difficulty.balloons,Status.ACTIVE,0);}
    public static Transition guess(State s,String raw){if(raw==null||!raw.matches("[a-zA-Z]"))throw new IllegalArgumentException("INVALID_LETTER");char c=raw.toUpperCase(Locale.ROOT).charAt(0);if(s.status!=Status.ACTIVE||s.used(c))return new Transition(s,false);int remaining=s.remaining-(s.answer.indexOf(c)>=0?0:1);return complete(new State(s.answer,s.difficulty,s.prefilled,s.guessed+c,s.hinted,remaining,s.status,s.version+1));}
    public static Transition hint(State s,RandomGenerator random){if(s.status!=Status.ACTIVE||s.hinted.length()>=2)return new Transition(s,false);var unknown=distinctLetters(s.answer).stream().filter(c->!s.used(c)).toList();if(unknown.isEmpty())return new Transition(s,false);return complete(new State(s.answer,s.difficulty,s.prefilled,s.guessed,s.hinted+unknown.get(random.nextInt(unknown.size())),s.remaining,s.status,s.version+1));}
    private static Transition complete(State s){boolean solved=distinctLetters(s.answer).stream().allMatch(s::used);return new Transition(new State(s.answer,s.difficulty,s.prefilled,s.guessed,s.hinted,s.remaining,solved?Status.WON:s.remaining==0?Status.LOST:Status.ACTIVE,s.version),true);}
}
