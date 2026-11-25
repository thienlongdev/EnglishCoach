package com.englishcoach.exams.media;

import java.io.InputStream;

public interface ExamObjectStorage {

    void putObject(String objectKey, byte[] data, String contentType);

    byte[] getObject(String objectKey);

    InputStream getObjectStream(String objectKey);

    boolean objectExists(String objectKey);

    /**
     * Exams Phase 9E: size in bytes of a stored object without reading it (−1 when unknown). Lets the media endpoint
     * stream byte ranges instead of loading the whole object into memory.
     */
    default long contentLength(String objectKey) {
        return -1L;
    }

    void deleteObject(String objectKey);
}
