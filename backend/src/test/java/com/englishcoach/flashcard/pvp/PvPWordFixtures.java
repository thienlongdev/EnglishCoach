package com.englishcoach.flashcard.pvp;

import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.flashcard.repository.FlashcardRepository.PvPWordProjection;
import java.util.List;

public final class PvPWordFixtures {
    private PvPWordFixtures() {}
    public static List<PvPWordProjection> rows(List<DictionaryEntry> entries) {
        return entries.stream().<PvPWordProjection>map(entry -> new PvPWordProjection() {
            public Long getId() { return entry.getId(); }
            public String getWord() { return entry.getWord(); }
            public String getIpa() { return entry.getIpa(); }
            public String getVietnamese() { return entry.getGeneralTranslationVi(); }
            public String getMeaning() { return entry.getMeanings().get(0); }
        }).toList();
    }
}
