package com.englishcoach.reading.dto;

import com.englishcoach.reading.entity.ReadingMaterial.MaterialType;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class ReadingMaterialRequest {

    private String title;
    private String sourceUrl;
    private MaterialType materialType;
    private String contentText;
    private String fileUrl;
}
