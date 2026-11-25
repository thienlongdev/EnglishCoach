package com.englishcoach.exams.media;

import com.englishcoach.exams.config.ExamsProperties;
import lombok.extern.slf4j.Slf4j;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

@Slf4j
public class LocalExamObjectStorage implements ExamObjectStorage {

    private final Path basePath;

    public LocalExamObjectStorage(ExamsProperties properties) {
        String dir = properties.getStorage().getLocal().getBaseDir();
        this.basePath = Paths.get(dir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(basePath);
            log.info("Initialized LocalExamObjectStorage at base path: {}", basePath);
        } catch (IOException e) {
            throw new IllegalStateException("Failed to create local exams storage directory: " + basePath, e);
        }
    }

    private Path resolveSafePath(String objectKey) {
        Path resolved = basePath.resolve(objectKey).normalize();
        if (!resolved.startsWith(basePath)) {
            throw new SecurityException("Illegal path traversal in objectKey: " + objectKey);
        }
        return resolved;
    }

    @Override
    public void putObject(String objectKey, byte[] data, String contentType) {
        Path target = resolveSafePath(objectKey);
        try {
            Files.createDirectories(target.getParent());
            Files.write(target, data);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write local object: " + objectKey, e);
        }
    }

    @Override
    public byte[] getObject(String objectKey) {
        Path target = resolveSafePath(objectKey);
        try {
            return Files.readAllBytes(target);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read local object: " + objectKey, e);
        }
    }

    @Override
    public InputStream getObjectStream(String objectKey) {
        Path target = resolveSafePath(objectKey);
        try {
            return new FileInputStream(target.toFile());
        } catch (FileNotFoundException e) {
            throw new UncheckedIOException("Object not found: " + objectKey, e);
        }
    }

    @Override
    public long contentLength(String objectKey) {
        Path target = resolveSafePath(objectKey);
        try {
            return Files.size(target);
        } catch (IOException e) {
            throw new UncheckedIOException("Object not found: " + objectKey, e);
        }
    }

    @Override
    public boolean objectExists(String objectKey) {
        Path target = resolveSafePath(objectKey);
        return Files.exists(target);
    }

    @Override
    public void deleteObject(String objectKey) {
        Path target = resolveSafePath(objectKey);
        try {
            Files.deleteIfExists(target);
        } catch (IOException e) {
            log.warn("Failed to delete local object: {}", objectKey, e);
        }
    }
}
