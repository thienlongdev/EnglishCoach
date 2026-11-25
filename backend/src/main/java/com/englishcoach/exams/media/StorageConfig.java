package com.englishcoach.exams.media;

import com.englishcoach.exams.config.ExamsProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Slf4j
@Configuration
public class StorageConfig {

    @Bean
    public ExamObjectStorage examObjectStorage(ExamsProperties properties) {
        String type = properties.getStorage().getType();
        if ("s3".equalsIgnoreCase(type)) {
            try {
                return new S3ExamObjectStorage(properties);
            } catch (Exception e) {
                log.warn("Failed to initialize S3 storage, falling back to Local storage: {}", e.getMessage());
                return new LocalExamObjectStorage(properties);
            }
        }
        return new LocalExamObjectStorage(properties);
    }
}
