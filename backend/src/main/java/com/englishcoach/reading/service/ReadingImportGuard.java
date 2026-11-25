package com.englishcoach.reading.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;

/**
 * Resource and cost protection of the Reading document import (and of the Listening document extraction, which reuses
 * it). The SAME limits for every account — free or Premium: these are server-safety limits, not a paywall.
 *
 * <p>Text recognition runs on the AI host (PyMuPDF native text + local EasyOCR, one document at a time). That host
 * itself refuses a PDF above {@value #MAX_PDF_PAGES} pages (read from the PDF's page tree before any page is rendered)
 * and stops at the {@value #MAX_OCR_PAGES}th page that needs recognition; this guard runs BEFORE the document is sent:
 * declared type, real file signature, file size, decoded image dimensions from the image header (no full decode), at
 * most {@value #MAX_IN_FLIGHT} documents in recognition server-wide and one per account, and at most
 * {@value #DAILY_UPLOADS} documents per account and day. After recognition the text is capped at
 * {@value #MAX_WORDS} words (pasted text the same) before anything is stored.
 *
 * <p>The daily count is durable ({@link DocumentRecognitionLedger}, V100: survives restarts, shared by every backend
 * process); the recognition slots are per process. Abuse and cost protection, not an entitlement. Without a ledger
 * (slim unit tests only) the daily count is kept in this object.
 */
@Component
public class ReadingImportGuard {

    public static final int MAX_WORDS = 10_000;
    public static final int MAX_CHARS = 120_000;
    /**
     * Recognition cost limits (the OCR host handles one document at a time). Nginx spools request bodies on disk
     * ({@code /var/spool/nginx}, docker-compose.prod.yml) and accepts up to 40 MB, so these are the effective limits.
     */
    public static final long MAX_PDF_BYTES = 6L * 1024 * 1024;
    public static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;
    public static final long MAX_IMAGE_PIXELS = 25_000_000L;
    /** Enforced by the AI host's OCR service (OCR_MAX_PDF_PAGES / OCR_MAX_SCANNED_PAGES defaults); stated here for messages. */
    public static final int MAX_PDF_PAGES = 30, MAX_OCR_PAGES = 15;
    public static final int MAX_IN_FLIGHT = 2;
    public static final int DAILY_UPLOADS = 20;

    private static final Pattern WORD = Pattern.compile("\\s+");
    private static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    public enum Type { PDF, PNG, JPEG }

    private final Semaphore slots = new Semaphore(MAX_IN_FLIGHT);
    private final Set<Long> busyAccounts = ConcurrentHashMap.newKeySet();
    private final DocumentRecognitionLedger ledger;
    // in-object daily count, used only without a ledger (slim unit tests)
    private final Map<Long, int[]> uploadsToday = new ConcurrentHashMap<>();
    private volatile LocalDate countedDay = LocalDate.now(ZONE);

    /** Without a durable ledger: slim unit tests only. */
    public ReadingImportGuard() {
        this(null);
    }

    @Autowired
    public ReadingImportGuard(DocumentRecognitionLedger ledger) {
        this.ledger = ledger;
    }

    public static int words(String text) {
        if (text == null || text.isBlank()) return 0;
        return WORD.split(text.trim()).length;
    }

    /** Pasted / stored text: at most {@value #MAX_WORDS} words. */
    public static void checkText(String text) {
        if (text != null && (text.length() > MAX_CHARS || words(text) > MAX_WORDS)) {
            throw bad("Nội dung vượt quá " + format(MAX_WORDS) + " từ. Hãy chia tài liệu thành nhiều phần.");
        }
    }

    /** Type, signature, size and image dimensions, before the document leaves this server. */
    public Type preflight(MultipartFile file) {
        if (file == null || file.isEmpty()) throw bad("Tệp tải lên không được để trống.");
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase(Locale.ROOT);
        Type declared = name.endsWith(".pdf") ? Type.PDF : name.endsWith(".png") ? Type.PNG
                : name.endsWith(".jpg") || name.endsWith(".jpeg") ? Type.JPEG : null;
        if (declared == null) throw bad("Định dạng tệp không được hỗ trợ. Vui lòng tải lên tệp PDF, PNG hoặc JPG.");
        byte[] head;
        try (InputStream in = file.getInputStream()) {
            head = in.readNBytes(8);
        } catch (IOException e) {
            throw bad("Không thể đọc tệp đã tải lên. Vui lòng thử lại.");
        }
        if (signature(head) != declared) throw bad("Nội dung tệp không đúng định dạng " + declared.name() + ".");
        long max = declared == Type.PDF ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
        if (file.getSize() > max) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "Tệp quá lớn để xử lý (tối đa " + (max / 1024 / 1024) + " MB cho " + (declared == Type.PDF ? "PDF" : "ảnh") + ").");
        }
        if (declared != Type.PDF) checkImageDimensions(file);
        return declared;
    }

    static Type signature(byte[] h) {
        if (h.length >= 5 && h[0] == '%' && h[1] == 'P' && h[2] == 'D' && h[3] == 'F' && h[4] == '-') return Type.PDF;
        if (h.length >= 8 && (h[0] & 255) == 137 && h[1] == 'P' && h[2] == 'N' && h[3] == 'G') return Type.PNG;
        if (h.length >= 3 && (h[0] & 255) == 0xFF && (h[1] & 255) == 0xD8 && (h[2] & 255) == 0xFF) return Type.JPEG;
        return null;
    }

    private static void checkImageDimensions(MultipartFile file) {
        try (InputStream in = file.getInputStream(); ImageInputStream iis = ImageIO.createImageInputStream(in)) {
            Iterator<ImageReader> readers = iis == null ? null : ImageIO.getImageReaders(iis);
            if (readers == null || !readers.hasNext()) throw bad("Ảnh bị hỏng hoặc không đọc được.");
            ImageReader reader = readers.next();
            try {
                reader.setInput(iis, true, true);
                long pixels = (long) reader.getWidth(0) * reader.getHeight(0); // header only, no pixel decode
                if (pixels <= 0) throw bad("Ảnh bị hỏng hoặc không đọc được.");
                if (pixels > MAX_IMAGE_PIXELS) {
                    throw bad("Ảnh quá lớn để nhận dạng (tối đa 25 megapixel). Hãy chụp hoặc lưu ảnh ở độ phân giải thấp hơn.");
                }
            } finally {
                reader.dispose();
            }
        } catch (IOException e) {
            throw bad("Ảnh bị hỏng hoặc không đọc được.");
        }
    }

    /**
     * A recognition slot: at most {@value #MAX_IN_FLIGHT} server-wide, one per account, {@value #DAILY_UPLOADS} a day per
     * account. A refusal for a busy slot costs nothing; the day's unit is taken last, once the slot is held, and the
     * {@link Permit} settles it (sent and finished, sent and failed — both count — or never sent, which does not).
     */
    public Permit enter(Long userId) {
        if (userId != null && !busyAccounts.add(userId)) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Một tài liệu khác của bạn đang được xử lý. Vui lòng chờ.");
        }
        if (!slots.tryAcquire()) {
            if (userId != null) busyAccounts.remove(userId);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Hệ thống đang xử lý tài liệu khác. Vui lòng thử lại sau ít phút.");
        }
        Long usage = null;
        try {
            if (userId != null) usage = ledger != null ? Long.valueOf(ledger.reserve(userId, DAILY_UPLOADS)) : countInObject(userId);
        } catch (RuntimeException refused) {
            slots.release();
            busyAccounts.remove(userId);
            throw refused;
        }
        return new Permit(userId, usage);
    }

    private Long countInObject(Long userId) {
        rollDay();
        int[] count = uploadsToday.computeIfAbsent(userId, k -> new int[1]);
        synchronized (count) {
            if (count[0] >= DAILY_UPLOADS) {
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                        "Bạn đã tải lên " + DAILY_UPLOADS + " tài liệu hôm nay. Vui lòng thử lại vào ngày mai.");
            }
            count[0]++;
        }
        return -1L;
    }

    private void rollDay() {
        LocalDate today = LocalDate.now(ZONE);
        if (!today.equals(countedDay)) {
            synchronized (this) {
                if (!today.equals(countedDay)) {
                    uploadsToday.clear();
                    countedDay = today;
                }
            }
        }
        if (uploadsToday.size() > 50_000) uploadsToday.clear(); // memory bound
    }

    /**
     * Releases the recognition slot and settles the day's unit (try-with-resources). Unless told otherwise the document
     * counts as sent and failed: only {@link #succeeded()} or {@link #notSent()} change that.
     */
    public final class Permit implements AutoCloseable {
        private final Long userId;
        private final Long usage;
        private String outcome = "FAILED";
        private boolean closed;

        private Permit(Long userId, Long usage) {
            this.userId = userId;
            this.usage = usage;
        }

        /** Recognition answered with usable text. */
        public void succeeded() { outcome = "SUCCEEDED"; }

        /** The document never reached the recognition host (connection refused / connect timeout): not counted. */
        public void notSent() { outcome = "NOT_SENT"; }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            try {
                if (usage != null && ledger != null) ledger.settle(usage, outcome);
                else if (usage != null && "NOT_SENT".equals(outcome)) {
                    int[] count = uploadsToday.get(userId);
                    if (count != null) synchronized (count) { count[0] = Math.max(0, count[0] - 1); }
                }
            } finally {
                slots.release();
                if (userId != null) busyAccounts.remove(userId);
            }
        }
    }

    /** The OCR host's refusal in learner words, with the real limits (never its raw English text). */
    public static String hostRefusal(String error) {
        String e = error == null ? "" : error.toLowerCase(Locale.ROOT);
        if (e.contains("scanned pages")) return "PDF scan chỉ hỗ trợ tối đa " + MAX_OCR_PAGES + " trang cần nhận dạng.";
        if (e.contains("pages")) return "Tài liệu vượt quá giới hạn số trang (tối đa " + MAX_PDF_PAGES + " trang, PDF không đặt mật khẩu).";
        if (e.contains("megapixel")) return "Ảnh quá lớn để nhận dạng.";
        if (e.contains("mib") || e.contains("payload") || e.contains("exceeds")) return "Tệp quá lớn để xử lý.";
        if (e.contains("malformed") || e.contains("unreadable")) return "PDF bị hỏng hoặc không đọc được.";
        if (e.contains("no readable text")) return "Không tìm thấy văn bản đọc được trong tài liệu.";
        return "Không thể xử lý tài liệu này. Vui lòng kiểm tra lại tệp.";
    }

    private static String format(int n) {
        return String.format(Locale.ROOT, "%,d", n).replace(',', '.');
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
