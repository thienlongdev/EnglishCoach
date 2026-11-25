package com.englishcoach.content.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

@Data
@Configuration
@ConfigurationProperties(prefix = "content.rss")
public class RssProperties {
    private boolean enabled = true;
    private String cron = "0 0 */3 * * *";
    private int maxItemsPerSource = 10;
    private int maxAgeDays = 30;
    private int freshnessDays = 14;
    private List<RssSourceConfig> sources = new ArrayList<>();

    @Data
    public static class RssSourceConfig {
        private String key;
        private String name;
        private String url;
        private String category;
        private String defaultLevel = "B1";
        private int typicalReadMinutes = 3;
        private String contentPolicy = "SUMMARY_ONLY"; // SUMMARY_ONLY or FULL_TEXT
        private boolean enabled = true;
    }
}
