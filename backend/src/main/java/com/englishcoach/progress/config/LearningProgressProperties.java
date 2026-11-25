package com.englishcoach.progress.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.ZoneId;

@Configuration
@ConfigurationProperties(prefix = "app.learning")
@Getter
@Setter
public class LearningProgressProperties {

    private String timeZone = "Asia/Ho_Chi_Minh";

    public ZoneId getZoneId() {
        try {
            return ZoneId.of(timeZone != null && !timeZone.isBlank() ? timeZone : "Asia/Ho_Chi_Minh");
        } catch (Exception e) {
            return ZoneId.of("Asia/Ho_Chi_Minh");
        }
    }
}
