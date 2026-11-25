package com.englishcoach.listening.service;

import org.springframework.stereotype.Service;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import javax.sound.sampled.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Private media under the existing durable backend_storage volume; never Speaking's public cache. */
@Service
public class ListeningDocumentAudio {
    private final Path root;
    public ListeningDocumentAudio() { this(Path.of("storage/listening/documents")); }
    ListeningDocumentAudio(Path root) { this.root = root.toAbsolutePath().normalize(); }
    private Path file(Long user, UUID id) { return root.resolve(user.toString()).resolve(id + ".wav"); }

    public record Chunk(AudioFormat format, byte[] pcm, long frames) {
        public int millis() { return (int)Math.round(frames * 1000d / format.getFrameRate()); }
    }
    public Chunk decode(byte[] wav) throws Exception {
        if (wav == null || wav.length < 44 || wav.length > 6 * 1024 * 1024) throw new IOException("Invalid audio size");
        try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            AudioFormat f = stream.getFormat();
            if (!AudioFormat.Encoding.PCM_SIGNED.equals(f.getEncoding()) || f.getSampleSizeInBits() != 16
                    || f.getChannels() != 1 || f.getSampleRate() < 8000 || f.getSampleRate() > 48000 || f.isBigEndian())
                throw new IOException("Unsupported audio format");
            byte[] pcm = stream.readNBytes(6 * 1024 * 1024 + 1);
            if (pcm.length == 0 || pcm.length > 6 * 1024 * 1024 || pcm.length % f.getFrameSize() != 0)
                throw new IOException("Invalid frames");
            Chunk chunk = new Chunk(f, pcm, pcm.length / f.getFrameSize());
            if (chunk.millis() < 200 || chunk.millis() > 60000) throw new IOException("Invalid duration");
            return chunk;
        }
    }
    public void save(Long user, UUID id, List<Chunk> chunks) throws Exception {
        AudioFormat format = chunks.getFirst().format();
        long frames = chunks.stream().mapToLong(Chunk::frames).sum();
        long bytes = chunks.stream().mapToLong(c -> c.pcm().length).sum();
        if (bytes > 24 * 1024 * 1024 || frames / format.getFrameRate() > 300) throw new IOException("Audio limit");
        for (Chunk c : chunks) if (!format.matches(c.format())) throw new IOException("Audio format changed");
        Path target = file(user,id); Files.createDirectories(target.getParent());
        if (Files.getFileStore(target.getParent()).getUsableSpace() < bytes + 1024L * 1024 * 1024)
            throw new IOException("Insufficient private audio storage space");
        Path tmp = Files.createTempFile(target.getParent(), ".generation-", ".tmp");
        try {
            Enumeration<InputStream> streams = Collections.enumeration(chunks.stream()
                    .map(c -> (InputStream)new ByteArrayInputStream(c.pcm())).toList());
            try (AudioInputStream joined = new AudioInputStream(new SequenceInputStream(streams), format, frames)) {
                AudioSystem.write(joined, AudioFileFormat.Type.WAVE, tmp.toFile());
            }
            Files.move(tmp,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(tmp); }
    }
    public Resource load(Long user, UUID id) {
        Path path=file(user,id);
        if (!Files.isRegularFile(path) || !Files.isReadable(path))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,"Không tìm thấy âm thanh.");
        return new FileSystemResource(path);
    }
    public void delete(Long user, UUID id) {
        try { Files.deleteIfExists(file(user,id)); }
        catch (IOException e) { throw new IllegalStateException("Audio cleanup failed",e); }
    }
}
