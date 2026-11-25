package com.englishcoach.messenger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * The bytes of Messenger attachments, on the backend's storage volume. This is everyday sharing on a small server, not a drive: a short list of kinds, small sizes,
 * a few uploads at a time, and nothing is ever decoded here (pictures are prepared by the sender's browser; the server reads only a header to learn their size).
 *
 * A file's kind is decided from its first bytes and its structure, never from the name or the type the browser claims. Files are streamed to disk and never held in
 * memory. Names on disk are generated here; the name a person gave is only ever a label shown next to the file.
 */
@Component
public class MessengerFiles {
    private static final Logger log = LoggerFactory.getLogger(MessengerFiles.class);
    public static final int IMAGE_MAX = 5 * 1024 * 1024, FILE_MAX = 10 * 1024 * 1024, THUMB_MAX = 300 * 1024, AVATAR_MAX = 1024 * 1024;
    public static final int IMAGES_PER_MESSAGE = 4, FILES_PER_MESSAGE = 2, MESSAGE_MAX = 20 * 1024 * 1024;
    /** What one person may keep on the server, and add in thirty days. Unsending a message gives its space back. */
    public static final long LIVE_QUOTA = 300L * 1024 * 1024, MONTH_QUOTA = 150L * 1024 * 1024;
    public static final int WAITING_MAX = 12;
    private static final long MAX_PIXELS = 50_000_000L;
    private static final long KEEP_FREE = 2L * 1024 * 1024 * 1024;

    private static final Map<String, String> DOCUMENTS = Map.of(
            "pdf", "application/pdf", "txt", "text/plain; charset=utf-8", "csv", "text/csv; charset=utf-8",
            "doc", "application/msword", "xls", "application/vnd.ms-excel", "ppt", "application/vnd.ms-powerpoint",
            "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");

    private final Path root;
    /** A few uploads at a time: the rest are told to try again in a moment instead of queueing on the server. */
    private final Semaphore slots = new Semaphore(6);

    public MessengerFiles(@Value("${app.messenger.storage-dir:${MESSENGER_STORAGE_DIR:storage/messenger}}") String dir) {
        this.root = Path.of(dir).toAbsolutePath().normalize();
    }

    public record Stored(String kind, String mime, int size, Integer width, Integer height, String key) {}

    private static MessengerException fail(int status, String code) { return new MessengerException(status, code); }

    /** A label, never a path: no directories, no control characters, a sane length. */
    public static String label(String raw) {
        String name = raw == null ? "" : raw.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}\"<>|:*?]", "").strip();
        if (name.isEmpty() || name.startsWith(".")) name = "file" + name;
        return name.length() > 120 ? name.substring(0, 60) + "…" + name.substring(name.length() - 50) : name;
    }
    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private Path path(String key) {
        Path p = root.resolve(key).normalize();
        if (!p.startsWith(root)) throw fail(400, "INVALID_REQUEST");
        return p;
    }

    /** Streams an upload to a new file. {@code limit}: the most bytes it may have; one more is a refusal, whatever size was declared. */
    private Path receive(MultipartFile file, int limit, String key) throws IOException {
        if (file == null || file.isEmpty()) throw fail(400, "ATTACHMENT_EMPTY");
        if (file.getSize() > limit) throw fail(413, "ATTACHMENT_TOO_LARGE");
        if (root.toFile().getUsableSpace() < KEEP_FREE && Files.exists(root)) throw fail(507, "STORAGE_FULL");
        Path target = path(key), part = target.resolveSibling(target.getFileName() + ".part");
        Files.createDirectories(target.getParent());
        long written = 0;
        try (InputStream in = file.getInputStream(); OutputStream out = Files.newOutputStream(part)) {
            byte[] buffer = new byte[16 * 1024];
            for (int n; (n = in.read(buffer)) > 0; ) {
                written += n;
                if (written > limit) throw fail(413, "ATTACHMENT_TOO_LARGE");
                out.write(buffer, 0, n);
            }
        } catch (RuntimeException | IOException e) {
            Files.deleteIfExists(part);
            throw e;
        }
        if (written == 0) { Files.deleteIfExists(part); throw fail(400, "ATTACHMENT_EMPTY"); }
        return part;
    }

    private static byte[] head(Path file, int n) throws IOException {
        try (InputStream in = Files.newInputStream(file)) { return in.readNBytes(n); }
    }
    private static boolean starts(byte[] b, int... sig) {
        if (b.length < sig.length) return false;
        for (int i = 0; i < sig.length; i++) if ((b[i] & 0xFF) != sig[i]) return false;
        return true;
    }

    /** The kind and pixel size of a picture, from its header only. Null: not one of the four kinds accepted. */
    static Stored picture(byte[] b, int size) {
        if (starts(b, 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A) && b.length >= 24) {
            ByteBuffer bb = ByteBuffer.wrap(b);
            return new Stored("IMAGE", "image/png", size, bb.getInt(16), bb.getInt(20), null);
        }
        if (starts(b, 'G', 'I', 'F', '8') && b.length >= 10 && (b[4] == '7' || b[4] == '9') && b[5] == 'a') {
            ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
            return new Stored("IMAGE", "image/gif", size, bb.getShort(6) & 0xFFFF, bb.getShort(8) & 0xFFFF, null);
        }
        if (starts(b, 'R', 'I', 'F', 'F') && b.length >= 30 && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
            String chunk = new String(b, 12, 4, StandardCharsets.US_ASCII);
            int w, h;
            if (chunk.equals("VP8 ")) { w = bb.getShort(26) & 0x3FFF; h = bb.getShort(28) & 0x3FFF; }
            else if (chunk.equals("VP8L")) { int bits = bb.getInt(21); w = (bits & 0x3FFF) + 1; h = ((bits >> 14) & 0x3FFF) + 1; }
            else if (chunk.equals("VP8X")) { w = ((b[24] & 0xFF) | (b[25] & 0xFF) << 8 | (b[26] & 0xFF) << 16) + 1; h = ((b[27] & 0xFF) | (b[28] & 0xFF) << 8 | (b[29] & 0xFF) << 16) + 1; }
            else return null;
            return new Stored("IMAGE", "image/webp", size, w, h, null);
        }
        if (starts(b, 0xFF, 0xD8, 0xFF)) {
            // Walk the segments to the frame header that carries the size.
            int i = 2;
            while (i + 9 < b.length) {
                if ((b[i] & 0xFF) != 0xFF) return null;
                int marker = b[i + 1] & 0xFF;
                if (marker == 0xFF) { i++; continue; }
                if (marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01) { i += 2; continue; }
                int length = (b[i + 2] & 0xFF) << 8 | (b[i + 3] & 0xFF);
                if (length < 2) return null;
                boolean frame = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
                if (frame) return new Stored("IMAGE", "image/jpeg", size, (b[i + 7] & 0xFF) << 8 | (b[i + 8] & 0xFF), (b[i + 5] & 0xFF) << 8 | (b[i + 6] & 0xFF), null);
                i += 2 + length;
            }
            return null;
        }
        return null;
    }

    private static Stored checkedPicture(Path part, int size) throws IOException {
        // A JPEG's size sits after its metadata, which a camera may fill generously.
        Stored p = picture(head(part, 256 * 1024), size);
        if (p == null) return null;
        if (p.width() == null || p.height() == null || p.width() < 1 || p.height() < 1 || (long) p.width() * p.height() > MAX_PIXELS) throw fail(415, "ATTACHMENT_NOT_ALLOWED");
        return p;
    }

    /** SOC-08: Streams UTF-8 validation in bounded 8 KB chunks so large text files never allocate full heap buffers. */
    private static boolean utf8Text(Path part) throws IOException {
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        byte[] raw = new byte[8192];
        ByteBuffer inBuf = ByteBuffer.allocate(8192 + 8);
        CharBuffer outBuf = CharBuffer.allocate(8192 + 8);
        try (InputStream in = new BufferedInputStream(Files.newInputStream(part), 8192)) {
            int n;
            while ((n = in.read(raw, 0, Math.min(raw.length, inBuf.remaining()))) != -1) {
                for (int i = 0; i < n; i++) {
                    if (raw[i] == 0) return false;
                }
                inBuf.put(raw, 0, n);
                inBuf.flip();
                while (true) {
                    outBuf.clear();
                    CoderResult res = decoder.decode(inBuf, outBuf, false);
                    if (res.isError()) return false;
                    if (res.isUnderflow()) break;
                }
                inBuf.compact();
            }
            inBuf.flip();
            while (true) {
                outBuf.clear();
                CoderResult res = decoder.decode(inBuf, outBuf, true);
                if (res.isError()) return false;
                if (res.isUnderflow()) break;
            }
            while (true) {
                outBuf.clear();
                CoderResult res = decoder.flush(outBuf);
                if (res.isError()) return false;
                if (res.isUnderflow()) break;
            }
            return !inBuf.hasRemaining();
        }
    }

    /** An Office document is a ZIP with a fixed shape. Only the directory at its end is read: nothing is inflated, and macro-enabled parts are refused. */
    private static boolean office(Path part, String ext) {
        String folder = switch (ext) { case "docx" -> "word/"; case "xlsx" -> "xl/"; default -> "ppt/"; };
        try (ZipFile zip = new ZipFile(part.toFile())) {
            if (zip.size() > 5000) return false;
            boolean types = false, body = false;
            for (Enumeration<? extends ZipEntry> e = zip.entries(); e.hasMoreElements(); ) {
                String name = e.nextElement().getName();
                if (name.contains("..") || name.startsWith("/") || name.toLowerCase(Locale.ROOT).endsWith("vbaproject.bin")) return false;
                if (name.equals("[Content_Types].xml")) types = true;
                if (name.startsWith(folder)) body = true;
            }
            return types && body;
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * Keeps an upload if it is one of the kinds allowed, whatever its name claims. A picture is recognised by its header; a document by its extension AND its content.
     * Everything else (programs, scripts, pages, archives, SVG, media) is refused.
     */
    public Stored store(UUID id, MultipartFile file, String name) {
        if (!slots.tryAcquire()) throw fail(503, "UPLOADS_BUSY");
        try {
            String key = "a/" + id.toString().substring(0, 2) + "/" + id;
            Path part = receive(file, FILE_MAX, key);
            try {
                int size = (int) Files.size(part);
                Stored picture = checkedPicture(part, size);
                Stored kept;
                if (picture != null) {
                    if (size > IMAGE_MAX) throw fail(413, "ATTACHMENT_TOO_LARGE");
                    kept = new Stored("IMAGE", picture.mime(), size, picture.width(), picture.height(), key);
                } else {
                    String ext = extension(name), mime = DOCUMENTS.get(ext);
                    if (mime == null) throw fail(415, "ATTACHMENT_NOT_ALLOWED");
                    byte[] b = head(part, 16);
                    boolean ok = switch (ext) {
                        case "pdf" -> starts(b, '%', 'P', 'D', 'F', '-');
                        case "doc", "xls", "ppt" -> starts(b, 0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1);
                        case "docx", "xlsx", "pptx" -> starts(b, 'P', 'K', 0x03, 0x04) && office(part, ext);
                        default -> utf8Text(part);
                    };
                    if (!ok) throw fail(415, "ATTACHMENT_NOT_ALLOWED");
                    kept = new Stored("FILE", mime, size, null, null, key);
                }
                Files.move(part, path(key), StandardCopyOption.REPLACE_EXISTING);
                return kept;
            } finally {
                Files.deleteIfExists(part);
            }
        } catch (IOException e) {
            log.warn("[Messenger] attachment not stored: {}", e.getClass().getSimpleName());
            throw fail(503, "STORAGE_UNAVAILABLE");
        } finally {
            slots.release();
        }
    }

    /** A small picture beside a larger one (a preview, or a group's picture): must itself be a picture, and small. Null when none was sent. */
    public Stored storeSmall(String key, MultipartFile file, int limit) {
        if (file == null || file.isEmpty()) return null;
        try {
            Path part = receive(file, limit, key);
            try {
                Stored p = checkedPicture(part, (int) Files.size(part));
                if (p == null) throw fail(415, "ATTACHMENT_NOT_ALLOWED");
                Files.move(part, path(key), StandardCopyOption.REPLACE_EXISTING);
                return new Stored("IMAGE", p.mime(), p.size(), p.width(), p.height(), key);
            } finally {
                Files.deleteIfExists(part);
            }
        } catch (IOException e) {
            log.warn("[Messenger] picture not stored: {}", e.getClass().getSimpleName());
            throw fail(503, "STORAGE_UNAVAILABLE");
        }
    }

    public Path open(String key) {
        Path p = path(key);
        if (!Files.isRegularFile(p)) throw fail(404, "ATTACHMENT_NOT_FOUND");
        return p;
    }

    /** The type a stored picture is served with, read from the file itself. */
    public String pictureType(Path file) {
        try {
            byte[] b = head(file, 16);
            if (starts(b, 0xFF, 0xD8, 0xFF)) return "image/jpeg";
            if (starts(b, 0x89, 'P', 'N', 'G')) return "image/png";
            if (starts(b, 'G', 'I', 'F', '8')) return "image/gif";
            if (starts(b, 'R', 'I', 'F', 'F') && b.length >= 12 && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "image/webp";
        } catch (IOException e) { /* Served as bytes. */ }
        return "application/octet-stream";
    }

    public void delete(String key) {
        if (key == null) return;
        try { Files.deleteIfExists(path(key)); } catch (IOException | RuntimeException e) { log.warn("[Messenger] attachment not deleted: {}", e.getClass().getSimpleName()); }
    }
}
