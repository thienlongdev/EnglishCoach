package com.englishcoach.exams.media;

import com.englishcoach.exams.config.ExamsProperties;
import lombok.extern.slf4j.Slf4j;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3ClientBuilder;
import software.amazon.awssdk.services.s3.model.*;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;

@Slf4j
public class S3ExamObjectStorage implements ExamObjectStorage {

    private final S3Client s3Client;
    private final String bucketName;

    public S3ExamObjectStorage(ExamsProperties properties) {
        var s3Props = properties.getStorage().getS3();
        this.bucketName = s3Props.getBucket();

        S3ClientBuilder builder = S3Client.builder()
                .region(Region.of(s3Props.getRegion()));

        if (s3Props.getEndpoint() != null && !s3Props.getEndpoint().isBlank()) {
            builder.endpointOverride(URI.create(s3Props.getEndpoint()));
        }

        if (s3Props.getAccessKey() != null && s3Props.getSecretKey() != null) {
            builder.credentialsProvider(StaticCredentialsProvider.create(
                    AwsBasicCredentials.create(s3Props.getAccessKey(), s3Props.getSecretKey())
            ));
        }

        builder.forcePathStyle(s3Props.isPathStyleAccess());
        this.s3Client = builder.build();
        log.info("Initialized S3ExamObjectStorage targeting bucket: {}", bucketName);
    }

    @Override
    public void putObject(String objectKey, byte[] data, String contentType) {
        PutObjectRequest req = PutObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .contentType(contentType != null ? contentType : "application/octet-stream")
                .build();
        s3Client.putObject(req, RequestBody.fromBytes(data));
    }

    @Override
    public byte[] getObject(String objectKey) {
        GetObjectRequest req = GetObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .build();
        return s3Client.getObjectAsBytes(req).asByteArray();
    }

    @Override
    public InputStream getObjectStream(String objectKey) {
        GetObjectRequest req = GetObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .build();
        return s3Client.getObject(req);
    }

    @Override
    public long contentLength(String objectKey) {
        HeadObjectRequest req = HeadObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .build();
        Long length = s3Client.headObject(req).contentLength();
        return length != null ? length : -1L;
    }

    @Override
    public boolean objectExists(String objectKey) {
        try {
            HeadObjectRequest req = HeadObjectRequest.builder()
                    .bucket(bucketName)
                    .key(objectKey)
                    .build();
            s3Client.headObject(req);
            return true;
        } catch (NoSuchKeyException e) {
            return false;
        } catch (Exception e) {
            log.warn("Error checking object existence for key: {}", objectKey, e);
            return false;
        }
    }

    @Override
    public void deleteObject(String objectKey) {
        DeleteObjectRequest req = DeleteObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .build();
        s3Client.deleteObject(req);
    }
}
