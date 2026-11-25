package com.englishcoach.user.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.Resource;
import org.springframework.mock.web.MockMultipartFile;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class AvatarStorageServiceTest {

    @TempDir
    Path tempStorageDir;

    private AvatarStorageService avatarStorageService;

    @BeforeEach
    void setUp() {
        avatarStorageService = new AvatarStorageService(tempStorageDir.toString());
    }

    private byte[] createTestImageBytes(int width, int height, String format) throws IOException {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(Color.BLUE);
        g.fillRect(0, 0, width, height);
        g.dispose();

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(image, format, baos);
        return baos.toByteArray();
    }

    @Test
    @DisplayName("Should accept valid PNG and normalize to 256x256 PNG")
    void testStoreAvatar_ValidPng_AcceptedAndNormalized() throws IOException {
        byte[] imageBytes = createTestImageBytes(400, 300, "png");
        MockMultipartFile file = new MockMultipartFile("file", "test.png", "image/png", imageBytes);

        String storageKey = avatarStorageService.storeAvatar(100L, file);

        assertThat(storageKey).isEqualTo("100/avatar.png");
        Resource resource = avatarStorageService.loadAvatarResource(100L);
        assertThat(resource).isNotNull();
        assertThat(resource.exists()).isTrue();

        // Verify saved image is normalized to 256x256
        BufferedImage savedImage = ImageIO.read(resource.getInputStream());
        assertThat(savedImage.getWidth()).isEqualTo(256);
        assertThat(savedImage.getHeight()).isEqualTo(256);
    }

    @Test
    @DisplayName("Should accept valid JPEG and convert to 256x256 PNG")
    void testStoreAvatar_ValidJpeg_Accepted() throws IOException {
        byte[] imageBytes = createTestImageBytes(500, 500, "jpeg");
        MockMultipartFile file = new MockMultipartFile("file", "photo.jpg", "image/jpeg", imageBytes);

        String storageKey = avatarStorageService.storeAvatar(101L, file);

        assertThat(storageKey).isEqualTo("101/avatar.png");
        Resource resource = avatarStorageService.loadAvatarResource(101L);
        assertThat(resource).isNotNull();
        assertThat(resource.exists()).isTrue();

        BufferedImage savedImage = ImageIO.read(resource.getInputStream());
        assertThat(savedImage.getWidth()).isEqualTo(256);
        assertThat(savedImage.getHeight()).isEqualTo(256);
    }

    @Test
    @DisplayName("Should reject fake image disguised with png filename")
    void testStoreAvatar_FakeImage_Rejected() {
        byte[] fakeBytes = "This is not an image at all!".getBytes();
        MockMultipartFile file = new MockMultipartFile("file", "fake.png", "image/png", fakeBytes);

        assertThatThrownBy(() -> avatarStorageService.storeAvatar(102L, file))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported or invalid image format");
    }

    @Test
    @DisplayName("Should reject oversized image file greater than 2MB")
    void testStoreAvatar_OversizedFile_Rejected() {
        byte[] oversizedBytes = new byte[2 * 1024 * 1024 + 1];
        MockMultipartFile file = new MockMultipartFile("file", "huge.png", "image/png", oversizedBytes);

        assertThatThrownBy(() -> avatarStorageService.storeAvatar(103L, file))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("2MB limit");
    }

    @Test
    @DisplayName("Should replace existing avatar atomically")
    void testStoreAvatar_ReplaceExisting_Success() throws IOException {
        byte[] firstBytes = createTestImageBytes(200, 200, "png");
        MockMultipartFile firstFile = new MockMultipartFile("file", "first.png", "image/png", firstBytes);
        avatarStorageService.storeAvatar(104L, firstFile);

        byte[] secondBytes = createTestImageBytes(300, 300, "png");
        MockMultipartFile secondFile = new MockMultipartFile("file", "second.png", "image/png", secondBytes);
        String secondKey = avatarStorageService.storeAvatar(104L, secondFile);

        assertThat(secondKey).isEqualTo("104/avatar.png");
        Resource resource = avatarStorageService.loadAvatarResource(104L);
        assertThat(resource).isNotNull();
        assertThat(resource.exists()).isTrue();
    }

    @Test
    @DisplayName("Should delete avatar file idempotently")
    void testDeleteAvatar_Idempotent() throws IOException {
        byte[] bytes = createTestImageBytes(200, 200, "png");
        MockMultipartFile file = new MockMultipartFile("file", "avatar.png", "image/png", bytes);
        avatarStorageService.storeAvatar(105L, file);

        boolean deleted = avatarStorageService.deleteAvatar(105L);
        assertThat(deleted).isTrue();

        Resource resource = avatarStorageService.loadAvatarResource(105L);
        assertThat(resource).isNull();

        // Second delete should be safe and return false without error
        boolean secondDelete = avatarStorageService.deleteAvatar(105L);
        assertThat(secondDelete).isFalse();
    }
}
