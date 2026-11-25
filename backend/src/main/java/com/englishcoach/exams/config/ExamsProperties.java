package com.englishcoach.exams.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

@Data
@Configuration
@ConfigurationProperties(prefix = "app.exams")
public class ExamsProperties {

    public enum ExamRuntimePolicy {
        LOCAL_PRIVATE,
        PUBLIC_PRODUCTION
    }

    private boolean enabled = true;
    private String schema = "exams";
    private int expectedSchemaVersion = 4;
    private boolean strictMode = false;
    private ExamRuntimePolicy runtimePolicy = ExamRuntimePolicy.LOCAL_PRIVATE;

    private Worker worker = new Worker();
    private Storage storage = new Storage();
    private Ai ai = new Ai();
    private Limits limits = new Limits();

    @Data
    public static class Worker {
        private boolean enabled = true;
        private long pollIntervalMs = 1000L;
        private int objectiveConcurrency = 4;
        private int productiveConcurrency = 2;
        private int leaseDurationSeconds = 120;
        private int leaseRenewalSeconds = 30;
        private int stageTimeoutSeconds = 300;
    }

    @Data
    public static class Storage {
        /**
         * Storage provider type: "s3", "local", or "memory".
         */
        private String type = "memory";
        private String mode = "local"; // local | s3
        private S3 s3 = new S3();
        private Local local = new Local();

        @Data
        public static class S3 {
            private String bucket = "english-coach-exams";
            private String region = "us-east-1";
            private String endpoint = "http://localhost:9000";
            private String accessKey;
            private String secretKey;
            private boolean pathStyleAccess = true;
        }

        @Data
        public static class Local {
            private String baseDir = "storage/exams";
        }
    }

    @Data
    public static class Ai {
        private String url = "http://ai-service:8000";
        private int timeoutSeconds = 300;
        /** Bearer credential of the AI judge routes; no default (security release 2026-11-16, SEC-03). Never printed. */
        private String apiKey = "";
    }

    @Data
    public static class Limits {
        private int maxResponseBatchSize = 50;
        private int maxUploadChunkBytes = 5 * 1024 * 1024; // 5MB
        private int sessionLeaseSeconds = 45;
        private int sessionHeartbeatSeconds = 15;
        private int readinessTtlHours = 24;
        private int retentionDays = 180;
    }
}
