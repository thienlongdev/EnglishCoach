package com.englishcoach.dictionary.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DictionaryResponse {
    private String word;
    private String ipa;
    private String cefr;
    private List<String> meanings;
    private List<String> examples;
    private List<String> synonyms;
    private List<String> collocations;
}
