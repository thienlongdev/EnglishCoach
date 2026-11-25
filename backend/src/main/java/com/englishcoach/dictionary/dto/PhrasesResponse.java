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
public class PhrasesResponse {
    private String word;
    private List<CanonicalDictionaryResponse.PhrasalVerbDto> phrasalVerbs;
    private List<CanonicalDictionaryResponse.IdiomDto> idioms;
    private List<CanonicalDictionaryResponse.IdiomDto> expressions;
}
