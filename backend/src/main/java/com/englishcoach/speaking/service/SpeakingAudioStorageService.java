package com.englishcoach.speaking.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;

@Service
@Slf4j
public class SpeakingAudioStorageService {

    private final Path baseStorageDir;

    public SpeakingAudioStorageService(@Value("${speaking.audio.storage-dir:${SPEAKING_AUDIO_STORAGE_DIR:storage/speaking/audio}}") String storageDir) {
        this.baseStorageDir = Paths.get(storageDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.baseStorageDir);
            log.info("Speaking audio storage initialized at: {}", this.baseStorageDir);
        } catch (IOException e) {
            log.warn("Could not create speaking audio storage directory: {}", e.getMessage());
        }
    }

    public String sanitizeIdentifier(String id) {
        if (id == null) return "unknown";
        return id.replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    public String saveAttemptAudio(Long userId, String clientAttemptId, byte[] audioBytes, String filename) {
        if (userId == null || clientAttemptId == null || clientAttemptId.isBlank()) {
            return null;
        }
        if (audioBytes == null || audioBytes.length == 0) {
            return null;
        }

        String safeAttemptId = sanitizeIdentifier(clientAttemptId);
        Path userDir = baseStorageDir.resolve(String.valueOf(userId)).normalize();
        if (!userDir.startsWith(baseStorageDir)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid storage path");
        }

        try {
            Files.createDirectories(userDir);
            Path targetFile = userDir.resolve(safeAttemptId + ".bin").normalize();
            if (!targetFile.startsWith(userDir)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid file destination");
            }
            // Publish complete bytes once. Concurrent retries may reuse identical audio only.
            Path pending = Files.createTempFile(userDir, ".recording-", ".tmp");
            try {
                Files.write(pending, audioBytes);
                try {
                    Files.createLink(targetFile, pending);
                } catch (java.nio.file.FileAlreadyExistsException exists) {
                    if (Files.mismatch(targetFile, pending) != -1) {
                        throw new ResponseStatusException(HttpStatus.CONFLICT, "Recording identifier already in use");
                    }
                }
            } finally {
                Files.deleteIfExists(pending);
            }
            String audioRef = userId + "/" + safeAttemptId + ".bin";
            log.info("Persisted learner audio for user {} attempt {} -> {} ({} bytes)", userId, clientAttemptId, audioRef, audioBytes.length);
            return audioRef;
        } catch (IOException e) {
            log.error("Failed to persist attempt audio for user {} attempt {}: {}", userId, clientAttemptId, e.getMessage(), e);
            return null;
        }
    }

    public Resource loadAttemptAudioResource(Long userId, String clientAttemptId) {
        if (userId == null || clientAttemptId == null || clientAttemptId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "User ID and attempt ID are required");
        }

        Path userDir = baseStorageDir.resolve(String.valueOf(userId)).normalize();
        if (!userDir.startsWith(baseStorageDir)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
        }
        String safeAttemptId = sanitizeIdentifier(clientAttemptId);
        Path targetFile = userDir.resolve(safeAttemptId + ".bin").normalize();
        if (!targetFile.startsWith(userDir)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
        }

        if (!Files.isRegularFile(targetFile) || !Files.isReadable(targetFile)) {
            log.warn("Attempt audio file does not exist at: {}", targetFile);
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Recording audio not found on server");
        }
        try {
            if (!targetFile.toRealPath().startsWith(userDir.toRealPath())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
            }
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Recording audio not found on server");
        }

        return new FileSystemResource(targetFile);
    }

    public byte[] loadAttemptAudioBytes(Long userId, String clientAttemptId) {
        if (userId == null || clientAttemptId == null || clientAttemptId.isBlank()) {
            return null;
        }
        Path userDir = baseStorageDir.resolve(String.valueOf(userId)).normalize();
        if (!userDir.startsWith(baseStorageDir)) {
            return null;
        }
        String safeAttemptId = sanitizeIdentifier(clientAttemptId);
        Path targetFile = userDir.resolve(safeAttemptId + ".bin").normalize();
        if (!targetFile.startsWith(userDir) || !Files.isRegularFile(targetFile) || !Files.isReadable(targetFile)) {
            return null;
        }
        try {
            if (!targetFile.toRealPath().startsWith(userDir.toRealPath())) {
                return null;
            }
            return Files.readAllBytes(targetFile);
        } catch (IOException e) {
            log.error("Failed to read attempt audio bytes for user {} attempt {}: {}", userId, clientAttemptId, e.getMessage());
            return null;
        }
    }


    public String getAudioRefIfExists(Long userId, String clientAttemptId) {
        if (userId == null || clientAttemptId == null || clientAttemptId.isBlank()) {
            return null;
        }
        String safeAttemptId = sanitizeIdentifier(clientAttemptId);
        Path targetFile = baseStorageDir.resolve(String.valueOf(userId)).resolve(safeAttemptId + ".bin").normalize();
        if (Files.exists(targetFile)) {
            return userId + "/" + safeAttemptId + ".bin";
        }
        return null;
    }

    public void deleteAttemptAudioByRef(String audioRef) {
        if (audioRef == null || audioRef.isBlank()) {
            return;
        }
        try {
            Path targetFile = baseStorageDir.resolve(audioRef).normalize();
            if (targetFile.startsWith(baseStorageDir) && Files.exists(targetFile)) {
                Files.deleteIfExists(targetFile);
                log.info("Deleted attempt audio file at: {}", targetFile);
            }
        } catch (Exception e) {
            log.warn("Could not delete attempt audio file for ref {}: {}", audioRef, e.getMessage());
        }
    }

    public String detectAttemptAudioMime(Long userId, String clientAttemptId) {
        if (userId == null || clientAttemptId == null || clientAttemptId.isBlank()) {
            return "audio/webm";
        }
        Path userDir = baseStorageDir.resolve(String.valueOf(userId)).normalize();
        if (!userDir.startsWith(baseStorageDir)) {
            return "audio/webm";
        }
        String safeAttemptId = sanitizeIdentifier(clientAttemptId);
        Path targetFile = userDir.resolve(safeAttemptId + ".bin").normalize();
        if (!targetFile.startsWith(userDir) || !Files.isRegularFile(targetFile) || !Files.isReadable(targetFile)) {
            return "audio/webm";
        }
        try {
            if (!targetFile.toRealPath().startsWith(userDir.toRealPath())) {
                return "audio/webm";
            }
        } catch (IOException e) {
            return "audio/webm";
        }
        try (var is = Files.newInputStream(targetFile)) {
            byte[] header = new byte[12];
            int read = is.read(header);
            if (read >= 4) {
                if ((header[0] & 0xFF) == 0x1A && (header[1] & 0xFF) == 0x45
                        && (header[2] & 0xFF) == 0xDF && (header[3] & 0xFF) == 0xA3) {
                    return "audio/webm";
                }
                if (header[0] == 'O' && header[1] == 'g' && header[2] == 'g' && header[3] == 'S') {
                    return "audio/ogg";
                }
                if (header[0] == 'R' && header[1] == 'I' && header[2] == 'F' && header[3] == 'F') {
                    return "audio/wav";
                }
                if (header[0] == 'f' && header[1] == 'L' && header[2] == 'a' && header[3] == 'C') {
                    return "audio/flac";
                }
            }
            if (read >= 8) {
                if (header[4] == 'f' && header[5] == 't' && header[6] == 'y' && header[7] == 'p') {
                    return "audio/mp4";
                }
            }
            if (read >= 3 && header[0] == 'I' && header[1] == 'D' && header[2] == '3') {
                return "audio/mpeg";
            }
            if (read >= 2 && (header[0] & 0xFF) == 0xFF
                    && (header[1] & 0xE0) == 0xE0
                    && (header[1] & 0x18) != 0x08) {
                return "audio/mpeg";
            }
        } catch (Exception e) {
            log.debug("Could not detect audio mime type: {}", e.getMessage());
        }
        return "audio/webm";
    }

    public String saveTtsAudio(String voiceId, String hash, byte[] wavBytes) {
        if (voiceId == null || hash == null || wavBytes == null || wavBytes.length == 0) {
            return null;
        }
        String safeVoiceId = sanitizeIdentifier(voiceId);
        String safeHash = sanitizeIdentifier(hash);
        Path voiceDir = baseStorageDir.resolve("tts").resolve(safeVoiceId).normalize();
        if (!voiceDir.startsWith(baseStorageDir)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid TTS storage path");
        }

        try {
            Files.createDirectories(voiceDir);
            Path targetFile = voiceDir.resolve(safeHash + ".wav").normalize();
            if (!targetFile.startsWith(voiceDir)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid TTS file destination");
            }
            // Atomic temp-file write + move to prevent torn reads under concurrent requests
            Path pending = Files.createTempFile(voiceDir, ".tts-", ".tmp");
            try {
                Files.write(pending, wavBytes);
                try {
                    Files.move(pending, targetFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } catch (AtomicMoveNotSupportedException ex) {
                    Files.move(pending, targetFile, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(pending);
            }
            String ref = "tts/" + safeVoiceId + "/" + safeHash + ".wav";
            log.info("Persisted TTS audio: voiceId={}, hash={}, ref={}, bytes={}", safeVoiceId, safeHash, ref, wavBytes.length);
            return ref;
        } catch (IOException e) {
            log.error("Failed to persist TTS audio for voiceId={}, hash={}: {}", safeVoiceId, safeHash, e.getMessage(), e);
            return null;
        }
    }

    public boolean ttsAudioExists(String voiceId, String hash) {
        if (voiceId == null || hash == null) return false;
        String safeVoiceId = sanitizeIdentifier(voiceId);
        String safeHash = sanitizeIdentifier(hash);
        Path targetFile = baseStorageDir.resolve("tts").resolve(safeVoiceId).resolve(safeHash + ".wav").normalize();
        return targetFile.startsWith(baseStorageDir) && Files.exists(targetFile) && Files.isReadable(targetFile);
    }

    public Resource loadTtsAudioResource(String voiceId, String hash) {
        if (voiceId == null || hash == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "VoiceId and hash are required");
        }
        String safeVoiceId = sanitizeIdentifier(voiceId);
        String safeHash = sanitizeIdentifier(hash);
        Path targetFile = baseStorageDir.resolve("tts").resolve(safeVoiceId).resolve(safeHash + ".wav").normalize();
        if (!targetFile.startsWith(baseStorageDir)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
        }
        if (!Files.exists(targetFile) || !Files.isReadable(targetFile)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "TTS audio not found on server");
        }
        return new FileSystemResource(targetFile);
    }

    public Resource loadTtsAudioResourceByRef(String audioRef) {
        if (audioRef == null || audioRef.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio ref is required");
        }
        // A TTS ref names a file of the shared synthesized-speech cache only. The same base directory also holds every
        // learner's own recordings (<userId>/<attemptId>.bin): those are served by the owner-checked attempt endpoint.
        Path ttsDir = baseStorageDir.resolve("tts").normalize();
        Path targetFile;
        try {
            targetFile = baseStorageDir.resolve(audioRef).normalize();
        } catch (java.nio.file.InvalidPathException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid audio ref");
        }
        if (!targetFile.startsWith(ttsDir) || targetFile.equals(ttsDir)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
        }
        if (!targetFile.getFileName().toString().endsWith(".wav")) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
        }
        if (!Files.isRegularFile(targetFile) || !Files.isReadable(targetFile)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "TTS audio not found");
        }
        try {
            // a link inside the cache must not lead out of it
            if (!targetFile.toRealPath().startsWith(ttsDir.toRealPath())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to audio path");
            }
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "TTS audio not found");
        }
        return new FileSystemResource(targetFile);
    }
}
