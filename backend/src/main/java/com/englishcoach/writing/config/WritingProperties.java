package com.englishcoach.writing.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.writing")
public class WritingProperties {
    private boolean enabled = true;
    private boolean mutationsEnabled = true;
    private boolean assessmentsEnabled = true;
    private boolean workerEnabled = true;
    private int maxSentenceChars = 2000;
    private int maxDraftWords = 2000;
    private int maxDraftChars = 25000;
}
