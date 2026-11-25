package com.englishcoach.reading;

import com.englishcoach.reading.service.ReadingImportGuard;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.zip.CRC32;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Reading import limits: the same for every account, checked before a document is sent to text recognition. */
class ReadingImportGuardTest {

    private final ReadingImportGuard guard = new ReadingImportGuard();

    private static int status(Throwable e) {
        return ((ResponseStatusException) e).getStatusCode().value();
    }

    @Test
    void theRealFileSignatureMustMatchTheDeclaredType() {
        assertThat(guard.preflight(new MockMultipartFile("file", "a.pdf", "application/pdf", "%PDF-1.7\n".getBytes())))
                .isEqualTo(ReadingImportGuard.Type.PDF);
        assertThatThrownBy(() -> guard.preflight(new MockMultipartFile("file", "a.pdf", "application/pdf", "<html>".getBytes())))
                .satisfies(e -> assertThat(status(e)).isEqualTo(400));
        assertThatThrownBy(() -> guard.preflight(new MockMultipartFile("file", "a.png", "image/png", "%PDF-1.7".getBytes())))
                .satisfies(e -> assertThat(status(e)).isEqualTo(400));
        assertThatThrownBy(() -> guard.preflight(new MockMultipartFile("file", "a.docx", "application/octet-stream", "x".getBytes())))
                .satisfies(e -> assertThat(status(e)).isEqualTo(400));
    }

    @Test
    void anOversizedPdfIsRefusedBeforeRecognition() {
        byte[] big = new byte[(int) ReadingImportGuard.MAX_PDF_BYTES + 1];
        System.arraycopy("%PDF-1.7".getBytes(), 0, big, 0, 8);
        assertThatThrownBy(() -> guard.preflight(new MockMultipartFile("file", "book.pdf", "application/pdf", big)))
                .satisfies(e -> assertThat(status(e)).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE.value()))
                .hasMessageContaining("6 MB");
    }

    @Test
    void imageDimensionsAreReadFromTheHeaderAndCapped() throws Exception {
        assertThat(guard.preflight(new MockMultipartFile("file", "page.png", "image/png", png(800, 600)))).isEqualTo(ReadingImportGuard.Type.PNG);
        // a small file that declares 10,000 × 10,000 pixels (100 MP): refused without decoding the pixels
        assertThatThrownBy(() -> guard.preflight(new MockMultipartFile("file", "bomb.png", "image/png", withSize(png(8, 8), 10_000, 10_000))))
                .satisfies(e -> assertThat(status(e)).isEqualTo(400)).hasMessageContaining("25 megapixel");
    }

    @Test
    void textIsCappedAtTenThousandWords() {
        ReadingImportGuard.checkText("word ".repeat(10_000));
        assertThatThrownBy(() -> ReadingImportGuard.checkText("word ".repeat(10_001)))
                .satisfies(e -> assertThat(status(e)).isEqualTo(400)).hasMessageContaining("10.000 từ");
    }

    @Test
    void recognitionSlotsAreBoundedServerWideAndPerAccount() {
        try (var first = guard.enter(1L)) {
            assertThatThrownBy(() -> guard.enter(1L)).satisfies(e -> assertThat(status(e)).isEqualTo(429)); // one per account
            try (var second = guard.enter(2L)) {
                assertThatThrownBy(() -> guard.enter(3L)).satisfies(e -> assertThat(status(e)).isEqualTo(503)); // two server-wide
            }
            guard.enter(3L).close();
        }
        for (int i = 0; i < ReadingImportGuard.DAILY_UPLOADS; i++) guard.enter(9L).close(); // a day's uploads of one account
        assertThatThrownBy(() -> guard.enter(9L)).satisfies(e -> assertThat(status(e)).isEqualTo(429)).hasMessageContaining("hôm nay");
    }

    @Test
    void theOcrHostsRefusalsAreToldWithTheRealLimits() {
        assertThat(ReadingImportGuard.hostRefusal("PDF must be unencrypted and contain 1–30 pages.")).contains("30 trang");
        assertThat(ReadingImportGuard.hostRefusal("OCR is limited to 15 scanned pages.")).contains("15 trang cần nhận dạng");
        assertThat(ReadingImportGuard.hostRefusal("Traceback: secret path /app/x.py")).doesNotContain("/app");
    }

    private static byte[] png(int w, int h) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB), "png", out);
        return out.toByteArray();
    }

    /** Rewrites the IHDR width / height (and its CRC) of a PNG. */
    private static byte[] withSize(byte[] png, int w, int h) {
        byte[] b = png.clone();
        ByteBuffer.wrap(b, 16, 8).putInt(w).putInt(h); // IHDR data starts at byte 16
        CRC32 crc = new CRC32();
        crc.update(b, 12, 17);                         // "IHDR" + 13 data bytes
        ByteBuffer.wrap(b, 29, 4).putInt((int) crc.getValue());
        return b;
    }
}
