package com.englishcoach.community.service;

import com.englishcoach.community.entity.CommunityPostMedia;
import com.englishcoach.community.repository.CommunityPostMediaRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

@Service
@Slf4j
public class CommunityMediaStorageService {

    public static final long MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
    public static final long MAX_VIDEO_SIZE_BYTES = 30 * 1024 * 1024; // 30 MB
    public static final int MAX_IMAGE_DIMENSION = 4096; // 4096x4096 px max
    public static final long MAX_IMAGE_PIXELS = 16_000_000L; // 16 MP max
    private static final int HEADER_INSPECT_BYTES = 64;

    private static final List<String> ALLOWED_IMAGE_MIME_TYPES = Arrays.asList(
            "image/jpeg", "image/png", "image/webp"
    );

    private static final List<String> ALLOWED_VIDEO_MIME_TYPES = Arrays.asList(
            "video/mp4", "video/webm"
    );

    private enum DetectedFormat {
        JPEG("image/jpeg", ".jpg", false),
        PNG("image/png", ".png", false),
        WEBP("image/webp", ".webp", false),
        MP4("video/mp4", ".mp4", true),
        WEBM("video/webm", ".webm", true);

        final String mimeType;
        final String extension;
        final boolean video;

        DetectedFormat(String mimeType, String extension, boolean video) {
            this.mimeType = mimeType;
            this.extension = extension;
            this.video = video;
        }
    }

    private final Path baseStorageDir;
    private final CommunityPostMediaRepository mediaRepository;

    public CommunityMediaStorageService(
            @Value("${app.community.storage-dir:${COMMUNITY_STORAGE_DIR:storage/community}}") String storageDir,
            CommunityPostMediaRepository mediaRepository
    ) {
        this.baseStorageDir = Paths.get(storageDir).toAbsolutePath().normalize();
        this.mediaRepository = mediaRepository;
        try {
            Files.createDirectories(this.baseStorageDir);
            log.info("Community media storage initialized at: {}", this.baseStorageDir);
        } catch (IOException e) {
            log.warn("Could not create community media storage directory: {}", e.getMessage());
        }
    }

    /**
     * Backward-compatible image upload delegate.
     */
    public CommunityPostMedia uploadImage(Long userId, MultipartFile file) {
        return uploadMedia(userId, file);
    }

    /**
     * Validates media (image or video) via streaming to disk (never full-file heap buffering),
     * verifies magic bytes & image dimensions before decode (EC-SEC-2026-011 / EC-SEC-2026-014),
     * and derives stored extension/MIME strictly from the magic-byte-verified format.
     */
    public CommunityPostMedia uploadMedia(Long userId, MultipartFile file) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("Tệp tin không được để trống");
        }

        String rawContentType = file.getContentType();
        String contentType = rawContentType != null ? rawContentType.trim().toLowerCase(Locale.ROOT) : "";
        int semi = contentType.indexOf(';');
        if (semi >= 0) {
            contentType = contentType.substring(0, semi).trim();
        }
        String originalFilename = file.getOriginalFilename() != null ? file.getOriginalFilename() : "media";

        boolean isVideo = isVideoMedia(contentType, originalFilename);
        long maxAllowedBytes = isVideo ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;

        if (isVideo) {
            if (file.getSize() > MAX_VIDEO_SIZE_BYTES) {
                throw new IllegalArgumentException("Dung lượng video tối đa 30 MB");
            }
            if (!ALLOWED_VIDEO_MIME_TYPES.contains(contentType) && !hasValidVideoExtension(originalFilename)) {
                throw new IllegalArgumentException("Định dạng video không hỗ trợ. Chỉ chấp nhận MP4 và WebM.");
            }
        } else {
            if (file.getSize() > MAX_IMAGE_SIZE_BYTES) {
                throw new IllegalArgumentException("Dung lượng ảnh tối đa 5 MB");
            }
            if (!ALLOWED_IMAGE_MIME_TYPES.contains(contentType) && !hasValidImageExtension(originalFilename)) {
                throw new IllegalArgumentException("Định dạng ảnh không hỗ trợ. Chỉ chấp nhận JPG, PNG, WEBP.");
            }
        }

        Path tempFile = null;
        boolean moved = false;
        try {
            Files.createDirectories(baseStorageDir);
            tempFile = Files.createTempFile(baseStorageDir, "community_upload_", ".part");

            byte[] header = new byte[HEADER_INSPECT_BYTES];
            int headerLen = 0;
            long written = 0L;
            DetectedFormat detected = null;

            try (InputStream in = file.getInputStream(); OutputStream out = Files.newOutputStream(tempFile)) {
                byte[] buffer = new byte[16 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    written += n;
                    if (written > maxAllowedBytes) {
                        throw new IllegalArgumentException(isVideo
                                ? "Dung lượng video tối đa 30 MB"
                                : "Dung lượng ảnh tối đa 5 MB");
                    }
                    if (headerLen < HEADER_INSPECT_BYTES) {
                        int toCopy = Math.min(n, HEADER_INSPECT_BYTES - headerLen);
                        System.arraycopy(buffer, 0, header, headerLen, toCopy);
                        headerLen += toCopy;
                        if (headerLen >= 12 && detected == null) {
                            detected = verifyMagicFormat(header, headerLen, isVideo, contentType, originalFilename);
                        }
                    }
                    out.write(buffer, 0, n);
                }
            }

            if (written == 0L) {
                throw new IllegalArgumentException("Tệp tin không được để trống");
            }
            if (detected == null) {
                detected = verifyMagicFormat(header, headerLen, isVideo, contentType, originalFilename);
            }

            Integer width = null;
            Integer height = null;
            if (!detected.video) {
                int[] dims = readAndValidateImageDimensions(tempFile, detected, header, headerLen);
                width = dims[0];
                height = dims[1];
            }

            String uniqueFileName = UUID.randomUUID() + detected.extension;
            Path targetFile = baseStorageDir.resolve(uniqueFileName).normalize();
            if (!targetFile.startsWith(baseStorageDir)) {
                throw new IllegalArgumentException("Đường dẫn tệp không an toàn");
            }

            Files.move(tempFile, targetFile, StandardCopyOption.REPLACE_EXISTING);
            moved = true;

            CommunityPostMedia media = CommunityPostMedia.builder()
                    .userId(userId)
                    .storageKey(uniqueFileName)
                    .fileName(originalFilename)
                    .fileSize(written)
                    .mimeType(detected.mimeType)
                    .width(width)
                    .height(height)
                    .displayOrder(0)
                    .build();

            return mediaRepository.save(media);
        } catch (IllegalArgumentException iae) {
            throw iae;
        } catch (IOException e) {
            log.error("Failed to store community media: {}", e.getMessage(), e);
            throw new IllegalStateException("Không thể lưu tệp tin", e);
        } finally {
            if (tempFile != null && !moved) {
                try {
                    Files.deleteIfExists(tempFile);
                } catch (IOException ignored) {
                }
            }
        }
    }

    public Resource loadMediaResource(String storageKey) {
        if (storageKey == null || storageKey.isBlank()) {
            return null;
        }
        Path targetFile = baseStorageDir.resolve(storageKey).normalize();
        if (!targetFile.startsWith(baseStorageDir) || !Files.exists(targetFile) || !Files.isRegularFile(targetFile)) {
            return null;
        }
        return new FileSystemResource(targetFile.toFile());
    }

    private boolean isVideoMedia(String contentType, String filename) {
        if (contentType.startsWith("video/")) return true;
        String lower = filename.toLowerCase(Locale.ROOT);
        return lower.endsWith(".mp4") || lower.endsWith(".webm");
    }

    private boolean hasValidVideoExtension(String filename) {
        String lower = filename.toLowerCase(Locale.ROOT);
        return lower.endsWith(".mp4") || lower.endsWith(".webm");
    }

    private boolean hasValidImageExtension(String filename) {
        String lower = filename.toLowerCase(Locale.ROOT);
        return lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".webp");
    }

    private DetectedFormat verifyMagicFormat(byte[] bytes, int len, boolean expectVideo, String contentType, String filename) {
        if (bytes == null || len < 12) {
            throw new IllegalArgumentException(expectVideo
                    ? "Tệp tin video quá nhỏ hoặc không hợp lệ"
                    : "Tệp tin ảnh quá nhỏ hoặc không hợp lệ");
        }
        DetectedFormat detected = detectFormatByMagicBytes(bytes, len);
        if (expectVideo) {
            if (detected == null || !detected.video) {
                boolean declaredWebm = "video/webm".equals(contentType)
                        || filename.toLowerCase(Locale.ROOT).endsWith(".webm");
                throw new IllegalArgumentException(declaredWebm
                        ? "Dữ liệu tệp không khớp định dạng WebM"
                        : "Dữ liệu tệp không khớp định dạng MP4");
            }
            return detected;
        }
        if (detected == null || detected.video) {
            String lowerName = filename.toLowerCase(Locale.ROOT);
            if ("image/png".equals(contentType) || lowerName.endsWith(".png")) {
                throw new IllegalArgumentException("Dữ liệu tệp không khớp định dạng PNG");
            }
            if ("image/webp".equals(contentType) || lowerName.endsWith(".webp")) {
                throw new IllegalArgumentException("Dữ liệu tệp không khớp định dạng WEBP");
            }
            throw new IllegalArgumentException("Dữ liệu tệp không khớp định dạng JPEG");
        }
        return detected;
    }

    private static DetectedFormat detectFormatByMagicBytes(byte[] b, int len) {
        if (len >= 8
                && (b[0] & 0xFF) == 0x89 && (b[1] & 0xFF) == 0x50
                && (b[2] & 0xFF) == 0x4E && (b[3] & 0xFF) == 0x47
                && (b[4] & 0xFF) == 0x0D && (b[5] & 0xFF) == 0x0A
                && (b[6] & 0xFF) == 0x1A && (b[7] & 0xFF) == 0x0A) {
            return DetectedFormat.PNG;
        }
        if (len >= 3
                && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            return DetectedFormat.JPEG;
        }
        if (len >= 12
                && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            return DetectedFormat.WEBP;
        }
        if (len >= 4
                && (b[0] & 0xFF) == 0x1A && (b[1] & 0xFF) == 0x45
                && (b[2] & 0xFF) == 0xDF && (b[3] & 0xFF) == 0xA3) {
            return DetectedFormat.WEBM;
        }
        if (len >= 12 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p') {
            return DetectedFormat.MP4;
        }
        return null;
    }

    /**
     * EC-SEC-2026-011: Inspects image width/height strictly from the container header using
     * {@link ImageReader} (or WEBP chunk header) without ever allocating full pixel rasters.
     */
    private static int[] readAndValidateImageDimensions(
            Path imageFile,
            DetectedFormat format,
            byte[] header,
            int headerLen
    ) throws IOException {
        if (format == DetectedFormat.WEBP) {
            int[] webpDims = readWebpDimensions(header, headerLen);
            if (webpDims == null) {
                throw new IllegalArgumentException("Tệp tin WEBP không hợp lệ hoặc bị hỏng");
            }
            validateDimensions(webpDims[0], webpDims[1]);
            return webpDims;
        }

        try (ImageInputStream iis = ImageIO.createImageInputStream(imageFile.toFile())) {
            if (iis == null) {
                throw new IllegalArgumentException("Không thể đọc thông tin ảnh");
            }
            Iterator<ImageReader> readers = ImageIO.getImageReaders(iis);
            if (!readers.hasNext()) {
                throw new IllegalArgumentException("Định dạng ảnh không hỗ trợ. Chỉ chấp nhận JPG, PNG, WEBP.");
            }
            ImageReader reader = readers.next();
            try {
                reader.setInput(iis, true, true);
                int width = reader.getWidth(0);
                int height = reader.getHeight(0);
                validateDimensions(width, height);
                return new int[] { width, height };
            } finally {
                reader.dispose();
            }
        } catch (IllegalArgumentException iae) {
            throw iae;
        } catch (Exception e) {
            throw new IllegalArgumentException("Tệp tin ảnh không hợp lệ hoặc bị hỏng");
        }
    }

    private static void validateDimensions(int width, int height) {
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("Kích thước ảnh không hợp lệ");
        }
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
                || (long) width * (long) height > MAX_IMAGE_PIXELS) {
            throw new IllegalArgumentException(
                    "Kích thước ảnh vượt quá giới hạn tối đa (" + MAX_IMAGE_DIMENSION + "x" + MAX_IMAGE_DIMENSION + " px, tối đa 16 MP)"
            );
        }
    }

    private static int[] readWebpDimensions(byte[] b, int len) {
        if (len < 30) {
            return null;
        }
        String chunk = new String(b, 12, 4, StandardCharsets.US_ASCII);
        if ("VP8 ".equals(chunk)) {
            int w = ((b[26] & 0xFF) | ((b[27] & 0xFF) << 8)) & 0x3FFF;
            int h = ((b[28] & 0xFF) | ((b[29] & 0xFF) << 8)) & 0x3FFF;
            return new int[] { w, h };
        }
        if ("VP8L".equals(chunk)) {
            int bits = (b[21] & 0xFF)
                    | ((b[22] & 0xFF) << 8)
                    | ((b[23] & 0xFF) << 16)
                    | ((b[24] & 0xFF) << 24);
            int w = (bits & 0x3FFF) + 1;
            int h = ((bits >> 14) & 0x3FFF) + 1;
            return new int[] { w, h };
        }
        if ("VP8X".equals(chunk)) {
            int w = ((b[24] & 0xFF) | ((b[25] & 0xFF) << 8) | ((b[26] & 0xFF) << 16)) + 1;
            int h = ((b[27] & 0xFF) | ((b[28] & 0xFF) << 8) | ((b[29] & 0xFF) << 16)) + 1;
            return new int[] { w, h };
        }
        return null;
    }
}
