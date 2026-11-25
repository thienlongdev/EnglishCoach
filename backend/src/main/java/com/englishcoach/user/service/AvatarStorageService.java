package com.englishcoach.user.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.Iterator;

@Service
@Slf4j
public class AvatarStorageService {

    public static final long MAX_AVATAR_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB
    public static final int TARGET_AVATAR_DIMENSION = 256;
    public static final int MAX_INPUT_DIMENSION = 4096;
    public static final long MAX_INPUT_PIXELS = 16_000_000L;

    private final Path baseStorageDir;

    public AvatarStorageService(
            @Value("${app.avatar.storage-dir:${AVATAR_STORAGE_DIR:storage/avatars}}") String storageDir
    ) {
        this.baseStorageDir = Paths.get(storageDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(this.baseStorageDir);
            log.info("Avatar storage initialized at: {}", this.baseStorageDir);
        } catch (IOException e) {
            log.warn("Could not create avatar storage directory: {}", e.getMessage());
        }
    }

    /**
     * Validates image file, crops to square, scales to 256x256, encodes as PNG,
     * and atomically saves inside the user-scoped directory.
     *
     * @param userId Authenticated user ID
     * @param file Uploaded image file
     * @return storage key e.g. "{userId}/avatar.png"
     */
    public String storeAvatar(Long userId, MultipartFile file) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("Avatar file must not be empty");
        }
        if (file.getSize() > MAX_AVATAR_SIZE_BYTES) {
            throw new IllegalArgumentException("Avatar file size exceeds the 2MB limit");
        }

        Path userDir = resolveAndValidateUserDir(userId);

        try {
            Files.createDirectories(userDir);
        } catch (IOException e) {
            log.error("Failed to create avatar directory for user {}: {}", userId, e.getMessage());
            throw new IllegalStateException("Could not create avatar directory", e);
        }

        // Validate actual image bytes and header dimensions BEFORE decoding raster pixels (EC-SEC-2026-011)
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new IllegalArgumentException("Failed to read image bytes", e);
        }
        if (bytes.length > MAX_AVATAR_SIZE_BYTES) {
            throw new IllegalArgumentException("Avatar file size exceeds the 2MB limit");
        }

        BufferedImage originalImage;
        int width;
        int height;
        try (ImageInputStream iis = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            if (iis == null) {
                throw new IllegalArgumentException("Unsupported or invalid image format. Only JPEG and PNG are allowed.");
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new IllegalArgumentException("Unsupported or invalid image format. Only JPEG and PNG are allowed.");
            }
            ImageReader reader = readers.next();
            try {
                String formatName = reader.getFormatName();
                if (formatName == null || (!formatName.equalsIgnoreCase("png")
                        && !formatName.equalsIgnoreCase("jpeg")
                        && !formatName.equalsIgnoreCase("jpg"))) {
                    throw new IllegalArgumentException("Unsupported or invalid image format. Only JPEG and PNG are allowed.");
                }
                reader.setInput(iis, true, true);
                width = reader.getWidth(0);
                height = reader.getHeight(0);
                if (width <= 0 || height <= 0) {
                    throw new IllegalArgumentException("Image dimensions are invalid (0x0)");
                }
                if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION
                        || (long) width * (long) height > MAX_INPUT_PIXELS) {
                    throw new IllegalArgumentException("Image dimensions exceed maximum allowed 4096x4096px (16MP)");
                }
                originalImage = reader.read(0);
            } finally {
                reader.dispose();
            }
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException("Malformed image file", e);
        }

        if (originalImage == null) {
            throw new IllegalArgumentException("Unsupported or invalid image format. Only JPEG and PNG are allowed.");
        }
        width = originalImage.getWidth();
        height = originalImage.getHeight();
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("Image dimensions are invalid (0x0)");
        }
        if (width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION
                || (long) width * (long) height > MAX_INPUT_PIXELS) {
            throw new IllegalArgumentException("Image dimensions exceed maximum allowed 4096x4096px (16MP)");
        }

        // Center square crop
        int squareSize = Math.min(width, height);
        int cropX = (width - squareSize) / 2;
        int cropY = (height - squareSize) / 2;
        BufferedImage croppedImage = originalImage.getSubimage(cropX, cropY, squareSize, squareSize);

        // Normalize & scale to TARGET_AVATAR_DIMENSION x TARGET_AVATAR_DIMENSION
        BufferedImage normalizedImage = new BufferedImage(
                TARGET_AVATAR_DIMENSION,
                TARGET_AVATAR_DIMENSION,
                BufferedImage.TYPE_INT_ARGB
        );
        Graphics2D g2d = normalizedImage.createGraphics();
        try {
            g2d.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            g2d.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            g2d.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
            g2d.drawImage(croppedImage, 0, 0, TARGET_AVATAR_DIMENSION, TARGET_AVATAR_DIMENSION, null);
        } finally {
            g2d.dispose();
        }

        // Write safely to temp file, then atomically move to target
        Path tempFile = null;
        try {
            tempFile = Files.createTempFile(userDir, "avatar_tmp_", ".png");
            try (OutputStream os = Files.newOutputStream(tempFile)) {
                boolean encoded = ImageIO.write(normalizedImage, "png", os);
                if (!encoded) {
                    throw new IllegalStateException("Failed to encode normalized avatar to PNG");
                }
            }

            Path targetFile = userDir.resolve("avatar.png").normalize();
            if (!targetFile.startsWith(userDir)) {
                throw new IllegalArgumentException("Invalid file destination");
            }

            try {
                Files.move(tempFile, targetFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tempFile, targetFile, StandardCopyOption.REPLACE_EXISTING);
            }

            String storageKey = userId + "/avatar.png";
            log.info("Stored normalized avatar for user {} -> {}", userId, storageKey);
            return storageKey;
        } catch (IOException e) {
            log.error("Failed to store avatar for user {}: {}", userId, e.getMessage(), e);
            throw new IllegalStateException("Failed to save avatar file", e);
        } finally {
            if (tempFile != null) {
                try {
                    Files.deleteIfExists(tempFile);
                } catch (IOException ignored) {
                }
            }
        }
    }

    /**
     * Loads the avatar resource for an authenticated user.
     * Returns null if file does not exist.
     */
    public Resource loadAvatarResource(Long userId) {
        if (userId == null) {
            return null;
        }
        Path userDir = resolveAndValidateUserDir(userId);
        Path targetFile = userDir.resolve("avatar.png").normalize();
        if (!targetFile.startsWith(userDir)) {
            return null;
        }
        if (!Files.exists(targetFile) || !Files.isRegularFile(targetFile)) {
            return null;
        }
        return new FileSystemResource(targetFile.toFile());
    }

    /**
     * Gets the last modified time of the avatar file, or null if absent.
     */
    public Instant getAvatarLastModified(Long userId) {
        if (userId == null) {
            return null;
        }
        Path userDir = resolveAndValidateUserDir(userId);
        Path targetFile = userDir.resolve("avatar.png").normalize();
        if (!targetFile.startsWith(userDir) || !Files.exists(targetFile)) {
            return null;
        }
        try {
            return Files.getLastModifiedTime(targetFile).toInstant();
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Safely and idempotently deletes the user's avatar file.
     */
    public boolean deleteAvatar(Long userId) {
        if (userId == null) {
            return false;
        }
        Path userDir = resolveAndValidateUserDir(userId);
        Path targetFile = userDir.resolve("avatar.png").normalize();
        if (!targetFile.startsWith(userDir)) {
            return false;
        }
        try {
            boolean deleted = Files.deleteIfExists(targetFile);
            log.info("Deleted avatar file for user {}: {}", userId, deleted);
            return deleted;
        } catch (IOException e) {
            log.warn("Failed to delete avatar file for user {}: {}", userId, e.getMessage());
            return false;
        }
    }

    private Path resolveAndValidateUserDir(Long userId) {
        Path userDir = baseStorageDir.resolve(String.valueOf(userId)).normalize();
        if (!userDir.startsWith(baseStorageDir)) {
            throw new IllegalArgumentException("Path traversal attempt detected");
        }
        return userDir;
    }
}
