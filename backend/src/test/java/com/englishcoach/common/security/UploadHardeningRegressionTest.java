package com.englishcoach.common.security;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.exception.GlobalExceptionHandler;
import com.englishcoach.community.controller.CommunityMediaController;
import com.englishcoach.community.dto.CommunityPostMediaDto;
import com.englishcoach.community.entity.CommunityPostMedia;
import com.englishcoach.community.repository.CommunityPostMediaRepository;
import com.englishcoach.community.service.CommunityMediaStorageService;
import com.englishcoach.community.service.CommunityRestrictionService;
import com.englishcoach.dictionary.controller.DictionaryController;
import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.englishcoach.dictionary.service.DictionaryService;
import com.englishcoach.flashcard.controller.FlashcardController;
import com.englishcoach.flashcard.dto.CardBlastFinishRunRequest;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.service.AnkiNoteParser;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.messenger.MessengerException;
import com.englishcoach.messenger.MessengerFiles;
import com.englishcoach.user.service.AvatarStorageService;
import com.englishcoach.writing.dto.WritingErrorResponse;
import com.englishcoach.writing.exception.WritingAiServiceException;
import com.englishcoach.writing.exception.WritingExceptionHandler;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Security regression tests for upload hardening, archive/SQLite safety, error sanitization, and input limits:
 * - EC-SEC-2026-011: ImageIO decompression bomb (crafted 20000x20000 PNG header) rejected before raster decode
 * - EC-SEC-2026-012: Malicious .apkg containing SQLite VIEW named 'notes' or 'col' rejected
 * - EC-SEC-2026-014: Community media magic-byte extension derivation & restriction enforcement
 * - BIZ-04 / AUTHZ-15: Card Blast impossible stat rejection & Flashcard pagination clamping
 * - SOC-08: MessengerFiles streaming UTF-8 validation across chunk boundaries
 * - EC-SEC-2026-037: GlobalExceptionHandler & WritingExceptionHandler strip internal Tailscale URLs/ports
 * - AI-14: DictionaryController rejects >80-char word on /v2/lookup
 */
class UploadHardeningRegressionTest {

    @TempDir
    Path tempDir;

    /** Builds a tiny valid-CRC PNG header claiming arbitrary width x height (no pixel data allocated). */
    private static byte[] craftedPngBombHeader(int width, int height) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        // PNG signature
        out.write(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
        // IHDR chunk (13 bytes)
        ByteArrayOutputStream ihdrData = new ByteArrayOutputStream();
        try (DataOutputStream dos = new DataOutputStream(ihdrData)) {
            dos.writeInt(width);
            dos.writeInt(height);
            dos.writeByte(8); // bit depth
            dos.writeByte(2); // color type RGB
            dos.writeByte(0); // compression
            dos.writeByte(0); // filter
            dos.writeByte(0); // interlace
        }
        writePngChunk(out, "IHDR", ihdrData.toByteArray());
        writePngChunk(out, "IDAT", new byte[] {0x78, (byte) 0x9C, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01});
        writePngChunk(out, "IEND", new byte[0]);
        return out.toByteArray();
    }

    private static void writePngChunk(ByteArrayOutputStream out, String type, byte[] data) throws IOException {
        DataOutputStream dos = new DataOutputStream(out);
        dos.writeInt(data.length);
        byte[] typeBytes = type.getBytes(StandardCharsets.US_ASCII);
        dos.write(typeBytes);
        dos.write(data);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        dos.writeInt((int) crc.getValue());
    }

    private static byte[] smallJpegBytes() throws IOException {
        BufferedImage img = new BufferedImage(32, 24, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = img.createGraphics();
        g.setColor(Color.GREEN);
        g.fillRect(0, 0, 32, 24);
        g.dispose();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(img, "jpeg", baos);
        return baos.toByteArray();
    }

    // ─── EC-SEC-2026-011: ImageIO Decompression Bomb ─────────────────────────

    @Test
    @DisplayName("EC-SEC-2026-011: AvatarStorageService rejects crafted 20000x20000 PNG bomb BEFORE raster allocation")
    void avatarStorageRejectsDecompressionBomb() throws Exception {
        AvatarStorageService service = new AvatarStorageService(tempDir.resolve("avatars").toString());
        byte[] bombPng = craftedPngBombHeader(20_000, 20_000);
        assertTrue(bombPng.length < 256, "Bomb payload must be tiny");

        MockMultipartFile file = new MockMultipartFile("file", "bomb.png", "image/png", bombPng);
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> service.storeAvatar(77L, file));
        assertTrue(ex.getMessage().contains("4096"), "Expected dimension bound error, got: " + ex.getMessage());
        assertNull(service.loadAvatarResource(77L));
    }

    @Test
    @DisplayName("EC-SEC-2026-011: CommunityMediaStorageService rejects crafted 20000x20000 PNG bomb BEFORE raster allocation")
    void communityMediaRejectsDecompressionBomb() throws Exception {
        Path mediaDir = tempDir.resolve("community-bomb");
        CommunityPostMediaRepository repo = mock(CommunityPostMediaRepository.class);
        CommunityMediaStorageService service = new CommunityMediaStorageService(mediaDir.toString(), repo);

        byte[] bombPng = craftedPngBombHeader(20_000, 20_000);
        MockMultipartFile file = new MockMultipartFile("file", "bomb.png", "image/png", bombPng);

        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> service.uploadMedia(77L, file));
        assertTrue(ex.getMessage().contains("4096"), "Expected dimension bound error, got: " + ex.getMessage());
        verify(repo, never()).save(any());
        try (var files = Files.list(mediaDir)) {
            assertEquals(0L, files.count(), "No temp or stored files may remain after bomb rejection");
        }
    }

    // ─── EC-SEC-2026-014: Community Media Extension Derivation & Restrictions ─

    @Test
    @DisplayName("EC-SEC-2026-014: CommunityMediaStorageService derives extension from magic bytes (never filename substring) and controller enforces restrictions + no-store")
    void communityMediaMagicExtensionAndRestrictionEnforcement() throws Exception {
        Path mediaDir = tempDir.resolve("community-magic");
        CommunityPostMediaRepository repo = mock(CommunityPostMediaRepository.class);
        when(repo.save(any(CommunityPostMedia.class))).thenAnswer(inv -> {
            CommunityPostMedia m = inv.getArgument(0);
            m.setId(55L);
            return m;
        });
        CommunityMediaStorageService storageService = new CommunityMediaStorageService(mediaDir.toString(), repo);

        // JPEG bytes with misleading "png" substring in filename must be stored strictly as .jpg / image/jpeg
        MockMultipartFile trickyJpeg = new MockMultipartFile("file", "my_png_photo.png", "image/jpeg", smallJpegBytes());
        CommunityPostMedia saved = storageService.uploadMedia(10L, trickyJpeg);
        assertEquals("image/jpeg", saved.getMimeType());
        assertTrue(saved.getStorageKey().endsWith(".jpg"), "Storage key must derive from JPEG magic bytes: " + saved.getStorageKey());
        assertEquals(32, saved.getWidth());
        assertEquals(24, saved.getHeight());

        // Restricted user is blocked by CommunityMediaController before storageService runs
        CommunityRestrictionService restrictionService = mock(CommunityRestrictionService.class);
        doThrow(new AccessDeniedException("Restricted")).when(restrictionService).assertCanPost(99L);
        CommunityMediaStorageService mockStorage = mock(CommunityMediaStorageService.class);
        CommunityMediaController controller = new CommunityMediaController(mockStorage, restrictionService);

        UserDetailsImpl restrictedUser = new UserDetailsImpl(99L, "r@test.local", "pw", List.of());
        assertThrows(AccessDeniedException.class, () -> controller.uploadMedia(restrictedUser, trickyJpeg));
        verifyNoInteractions(mockStorage);

        // Allowed user receives Cache-Control: private, no-store on upload response
        UserDetailsImpl allowedUser = new UserDetailsImpl(10L, "ok@test.local", "pw", List.of());
        when(mockStorage.uploadMedia(eq(10L), any())).thenReturn(saved);
        ResponseEntity<CommunityPostMediaDto> okResp = controller.uploadMedia(allowedUser, trickyJpeg);
        assertEquals(HttpStatus.CREATED, okResp.getStatusCode());
        String cacheControl = okResp.getHeaders().getCacheControl();
        assertNotNull(cacheControl);
        assertTrue(cacheControl.contains("private"));
        assertTrue(cacheControl.contains("no-store"));
    }

    // ─── EC-SEC-2026-012: Crafted .apkg with SQLite VIEW Rejected ────────────

    @Test
    @DisplayName("EC-SEC-2026-012: FlashcardService rejects crafted .apkg where 'notes' is a SQLite VIEW")
    void apkgImportRejectsSqliteViewNotes() throws Exception {
        FlashcardService flashcardService = new FlashcardService(
                mock(FlashcardRepository.class),
                mock(UserRepository.class),
                mock(DictionaryRepository.class),
                new AnkiNoteParser()
        );

        byte[] maliciousApkg = buildApkgWithSql(
                "CREATE TABLE col (models TEXT);",
                "INSERT INTO col (models) VALUES ('{}');",
                "CREATE VIEW notes AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 5) "
                        + "SELECT x AS id, 100 AS mid, 'hello' || char(31) || 'world' AS flds FROM c;"
        );
        MockMultipartFile file = new MockMultipartFile("file", "evil.apkg", "application/octet-stream", maliciousApkg);

        ResponseStatusException ex = assertThrows(ResponseStatusException.class,
                () -> flashcardService.importApkgDetails(42L, file));
        assertEquals(HttpStatus.BAD_REQUEST, HttpStatus.valueOf(ex.getStatusCode().value()));
        assertTrue(ex.getReason() != null && ex.getReason().contains("must be a table"),
                "Expected table-only schema rejection, got: " + ex.getReason());
    }

    private byte[] buildApkgWithSql(String... statements) throws Exception {
        File dbFile = tempDir.resolve("crafted_" + UUID.randomUUID() + ".db").toFile();
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + dbFile.getAbsolutePath());
             Statement stmt = conn.createStatement()) {
            for (String sql : statements) {
                stmt.execute(sql);
            }
        }
        ByteArrayOutputStream zipOut = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(zipOut)) {
            zos.putNextEntry(new ZipEntry("collection.anki21"));
            zos.write(Files.readAllBytes(dbFile.toPath()));
            zos.closeEntry();
        }
        return zipOut.toByteArray();
    }

    // ─── BIZ-04 & AUTHZ-15: Card Blast Stats & Flashcard Pagination ──────────

    @Test
    @DisplayName("BIZ-04 & AUTHZ-15: Card Blast rejects impossible hits > totalAttempts and negative stats; FlashcardController clamps page/size")
    void cardBlastValidationAndFlashcardPaginationClamping() {
        FlashcardService flashcardService = mock(FlashcardService.class);
        when(flashcardService.getUserFlashcards(eq(10L), any(), any(), any(), any(Pageable.class)))
                .thenReturn(Page.empty());

        FlashcardController controller = new FlashcardController(flashcardService);
        UserDetailsImpl user = new UserDetailsImpl(10L, "u@test.local", "pw", List.of());

        controller.getUserFlashcards(user, null, null, null, -5, 99_999);
        ArgumentCaptor<Pageable> pageableCaptor = ArgumentCaptor.forClass(Pageable.class);
        verify(flashcardService).getUserFlashcards(eq(10L), isNull(), isNull(), isNull(), pageableCaptor.capture());
        assertEquals(0, pageableCaptor.getValue().getPageNumber());
        assertEquals(100, pageableCaptor.getValue().getPageSize());

        FlashcardService realService = new FlashcardService(
                mock(FlashcardRepository.class),
                mock(UserRepository.class),
                mock(DictionaryRepository.class),
                new AnkiNoteParser()
        );
        ResponseStatusException impossible = assertThrows(ResponseStatusException.class,
                () -> realService.recordCardBlastRun(10L, new CardBlastFinishRunRequest(null, 100, 100.0, List.of(), 25, 10, "run-1")));
        assertEquals(HttpStatus.BAD_REQUEST, HttpStatus.valueOf(impossible.getStatusCode().value()));

        ResponseStatusException negative = assertThrows(ResponseStatusException.class,
                () -> realService.recordCardBlastRun(10L, new CardBlastFinishRunRequest(null, -1, 50.0, List.of(), 1, 2, "run-2")));
        assertEquals(HttpStatus.BAD_REQUEST, HttpStatus.valueOf(negative.getStatusCode().value()));
    }

    // ─── SOC-08: MessengerFiles Streaming UTF-8 Validation ───────────────────

    @Test
    @DisplayName("SOC-08: MessengerFiles validates multi-chunk UTF-8 text files via streaming and rejects NUL / malformed UTF-8")
    void messengerFilesStreamingUtf8Validation() {
        MessengerFiles files = new MessengerFiles(tempDir.resolve("messenger").toString());

        // Multi-byte Vietnamese text crossing multiple 8192-byte chunk boundaries
        String validText = "Học tiếng Anh mỗi ngày cùng Echo Coach! ".repeat(500);
        byte[] validUtf8 = validText.getBytes(StandardCharsets.UTF_8);
        assertTrue(validUtf8.length > 16_384);
        MockMultipartFile validFile = new MockMultipartFile("file", "notes.txt", "text/plain", validUtf8);

        MessengerFiles.Stored stored = files.store(UUID.randomUUID(), validFile, "notes.txt");
        assertEquals("FILE", stored.kind());
        assertEquals("text/plain; charset=utf-8", stored.mime());

        // NUL byte after 10 KB must be rejected
        byte[] withNul = new byte[12_000];
        java.util.Arrays.fill(withNul, (byte) 'a');
        withNul[10_500] = 0x00;
        MockMultipartFile nulFile = new MockMultipartFile("file", "binary.txt", "text/plain", withNul);
        MessengerException nulEx = assertThrows(MessengerException.class,
                () -> files.store(UUID.randomUUID(), nulFile, "binary.txt"));
        assertEquals("ATTACHMENT_NOT_ALLOWED", nulEx.getMessage());

        // Malformed UTF-8 byte sequence after 10 KB must be rejected
        byte[] invalidUtf8 = new byte[12_000];
        java.util.Arrays.fill(invalidUtf8, (byte) 'a');
        invalidUtf8[10_500] = (byte) 0xFF;
        invalidUtf8[10_501] = (byte) 0xFE;
        MockMultipartFile badUtf8File = new MockMultipartFile("file", "corrupt.txt", "text/plain", invalidUtf8);
        MessengerException utf8Ex = assertThrows(MessengerException.class,
                () -> files.store(UUID.randomUUID(), badUtf8File, "corrupt.txt"));
        assertEquals("ATTACHMENT_NOT_ALLOWED", utf8Ex.getMessage());
    }

    // ─── EC-SEC-2026-037: Upstream URL / Tailscale IP Sanitization ───────────

    @Test
    @DisplayName("EC-SEC-2026-037: GlobalExceptionHandler and WritingExceptionHandler strip internal Tailscale URLs, ports, and RestTemplate details")
    void exceptionHandlersStripInternalUrlsAndTailscaleIps() {
        GlobalExceptionHandler globalHandler = new GlobalExceptionHandler();

        ResponseEntity<Map<String, Object>> stateResp = globalHandler.handleIllegalArgumentException(
                new IllegalStateException("I/O error on POST request for \"http://100.88.12.34:8005/api/v1/score\": Connection refused"));
        assertEquals(HttpStatus.BAD_REQUEST, stateResp.getStatusCode());
        String stateMsg = String.valueOf(stateResp.getBody().get("message"));
        assertFalse(stateMsg.contains("100.88.12.34"), "Tailscale IP leaked: " + stateMsg);
        assertFalse(stateMsg.contains(":8005"), "Internal port leaked: " + stateMsg);
        assertFalse(stateMsg.contains("http://"), "Internal URL leaked: " + stateMsg);
        assertFalse(stateMsg.contains("I/O error on"), "RestTemplate text leaked: " + stateMsg);

        ResponseEntity<Map<String, Object>> statusResp = globalHandler.handleResponseStatusException(
                new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Failed calling http://127.0.0.1:8000/v1/chat"));
        assertEquals(HttpStatus.BAD_GATEWAY, statusResp.getStatusCode());
        String statusMsg = String.valueOf(statusResp.getBody().get("message"));
        assertFalse(statusMsg.contains("127.0.0.1"));
        assertFalse(statusMsg.contains(":8000"));
        assertFalse(statusMsg.contains("http://"));

        // Benign validation message mentioning 100.0 is NOT falsely redacted
        ResponseEntity<Map<String, Object>> benignResp = globalHandler.handleIllegalArgumentException(
                new IllegalArgumentException("Điểm tối đa là 100.0"));
        assertEquals("Điểm tối đa là 100.0", benignResp.getBody().get("message"));

        // WritingExceptionHandler never exposes upstream URL or RestTemplate details
        WritingExceptionHandler writingHandler = new WritingExceptionHandler();
        ResponseEntity<WritingErrorResponse> writingResp = writingHandler.handleAiService(
                new WritingAiServiceException("AI Service Document Assessment failed: I/O error on POST request for \"http://100.77.11.22:8000/api/v1/writing/document-assessment\""));
        assertEquals(HttpStatus.BAD_GATEWAY, writingResp.getStatusCode());
        assertNotNull(writingResp.getBody());
        assertEquals("AI_SERVICE_ERROR", writingResp.getBody().getCode());
        String writingMsg = writingResp.getBody().getMessage();
        assertFalse(writingMsg.contains("100.77.11.22"));
        assertFalse(writingMsg.contains(":8000"));
        assertFalse(writingMsg.contains("http://"));
        assertFalse(writingMsg.contains("I/O error on"));
    }

    // ─── AI-14: DictionaryController Word Length Guard ───────────────────────

    @Test
    @DisplayName("AI-14: DictionaryController /v2/lookup rejects words longer than 80 characters with 400 Bad Request")
    void dictionaryControllerRejectsOversizedWord() {
        DictionaryEngine engine = mock(DictionaryEngine.class);
        DictionaryService legacyService = mock(DictionaryService.class);
        DictionaryController controller = new DictionaryController(engine, legacyService);

        ResponseEntity<CanonicalDictionaryResponse> tooLong = controller.lookupV2("a".repeat(81), "en-en");
        assertEquals(HttpStatus.BAD_REQUEST, tooLong.getStatusCode());
        verifyNoInteractions(engine);

        CanonicalDictionaryResponse okDto = CanonicalDictionaryResponse.builder().headword("a".repeat(80)).build();
        when(engine.lookup("a".repeat(80), "en-en")).thenReturn(okDto);
        ResponseEntity<CanonicalDictionaryResponse> ok = controller.lookupV2("a".repeat(80), "en-en");
        assertEquals(HttpStatus.OK, ok.getStatusCode());
        assertEquals(okDto, ok.getBody());
    }
}
