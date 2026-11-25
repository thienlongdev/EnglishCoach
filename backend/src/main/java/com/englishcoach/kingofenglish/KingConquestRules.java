package com.englishcoach.kingofenglish;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import java.util.*;
import static com.englishcoach.kingofenglish.KingConfig.*;
/** Identical bounded move validation for humans and Echo, on every board size. No full-board solving. */
final class KingConquestRules {
    static String normalize(String input){return input==null?"":java.text.Normalizer.normalize(input,java.text.Normalizer.Form.NFKC).strip().toLowerCase(Locale.ROOT);}
    static String path(List<String> letters,String input,List<Integer> path){return path(letters,CONQUEST_DEFAULT_SIZE,input,path);}
    static String path(List<String> letters,int size,String input,List<Integer> path){
        String word=normalize(input);
        if(word.length()<3&&word.matches("[a-z]*"))throw new KingService.Rejection("WORD_TOO_SHORT");
        if(!word.matches("[a-z]{3,8}"))throw new KingService.Rejection("INVALID_WORD_LENGTH");
        int cells=size*size;
        if(letters.size()!=cells||path==null||path.size()!=word.length())throw new KingService.Rejection("INVALID_PATH");
        long used=0;int previous=-1;var value=new StringBuilder();
        for(Integer cell:path){
            if(cell==null||cell<0||cell>=cells)throw new KingService.Rejection("TILE_OUT_OF_RANGE");
            if((used&(1L<<cell))!=0)throw new KingService.Rejection("TILE_REUSED");
            if(previous>=0&&!KingConquestBoards.adjacent(previous,cell,size))throw new KingService.Rejection("NOT_ADJACENT");
            used|=1L<<cell;previous=cell;value.append(letters.get(cell).toLowerCase(Locale.ROOT));
        }
        if(!value.toString().equals(word))throw new KingService.Rejection("LETTERS_MISMATCH");return word;
    }
    static String validate(KingConquestBank.Board board,String input,List<Integer> path,Set<String> used,LocalGameLexicon lexicon){
        return validate(board,input,path,used,word->lexicon.lookupConquest(word).isPresent());
    }
    static String validate(KingConquestBank.Board board,String input,List<Integer> path,Set<String> used,java.util.function.Predicate<String> eligible){
        return validate(board.letters(),CONQUEST_DEFAULT_SIZE,input,path,used,eligible);
    }
    /** Path first (adjacency, reuse, letters), then the match's used words, then the dictionary: each failure names its own reason. */
    static String validate(List<String> letters,int size,String input,List<Integer> path,Set<String> used,java.util.function.Predicate<String> eligible){
        String word=path(letters,size,input,path);
        if(used.contains(word))throw new KingService.Rejection("WORD_USED");
        if(used.size()>=CONQUEST_WORD_CAP)throw new KingService.Rejection("WORD_LIMIT");
        if(!eligible.test(word))throw new KingService.Rejection("WORD_NOT_ELIGIBLE");return word;
    }
}
