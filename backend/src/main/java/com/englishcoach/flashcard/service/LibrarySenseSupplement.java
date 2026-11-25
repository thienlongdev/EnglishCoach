package com.englishcoach.flashcard.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Map;

/** Scoped to exact published deck, word and taught meaning. No lookup or writes for private cards. */
final class LibrarySenseSupplement {
    record Text(String meaning, String definition, String ipa) {}
    private static final class Holder {
        static final Map<String,Text> TEXT = load();
        private static Map<String,Text> load() {
            try (var input=LibrarySenseSupplement.class.getResourceAsStream("/data/vocabulary/initial-sense-supplement.json")) {
                if (input==null) throw new IllegalStateException("Missing vocabulary library supplement");
                return Map.copyOf(new ObjectMapper().readValue(input,new TypeReference<Map<String,Text>>(){}));
            } catch(IOException ex) { throw new IllegalStateException("Invalid library supplement",ex); }
        }
    }
    static Text find(String slug,String word,String meaning) {
        if(slug==null || !slug.startsWith("lib-") || word==null || meaning==null) return null;
        Text t=Holder.TEXT.get(slug+"|"+word.toLowerCase(java.util.Locale.ROOT));
        return t!=null && meaning.equals(t.meaning())?t:null;
    }
    private LibrarySenseSupplement(){}
}
