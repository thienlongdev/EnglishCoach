package com.englishcoach.reading.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.reading.dto.HighlightRequest;
import com.englishcoach.reading.dto.ReadingMaterialRequest;
import com.englishcoach.reading.dto.ReadingMaterialResponse;
import com.englishcoach.reading.entity.DocumentHighlight;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.DocumentHighlightRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.io.IOException;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.client.RestTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import com.englishcoach.reading.exception.OcrProcessingException;
import lombok.extern.slf4j.Slf4j;

@Service
@RequiredArgsConstructor
@Slf4j
public class ReadingService {

        private final ReadingMaterialRepository readingMaterialRepository;
        private final DocumentHighlightRepository documentHighlightRepository;
        private final UserRepository userRepository;

        @Autowired(required = false)
        private PlatformTransactionManager transactionManager;

        private <T> T inTx(java.util.function.Supplier<T> work) {
                if (transactionManager == null) return work.get();
                return new TransactionTemplate(transactionManager).execute(s -> work.get());
        }

        @org.springframework.beans.factory.annotation.Autowired
        private ReadingCatalogService catalogService;

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private com.englishcoach.auth.policy.AdminIdentityService adminIdentityService;

        public void setAdminIdentityService(com.englishcoach.auth.policy.AdminIdentityService adminIdentityService) {
                this.adminIdentityService = adminIdentityService;
        }

        private boolean isOfficialAdmin(Long userId) {
                if (userId == null) return false;
                if (adminIdentityService != null) {
                        return adminIdentityService.isOfficialAdmin(userId);
                }
                var session = com.englishcoach.common.security.AuthSessionContext.current();
                if (session != null && userId.equals(session.userId()) && session.adminAuthorityWithheld()) {
                        return false;
                }
                return userRepository.findById(userId)
                                .map(u -> com.englishcoach.auth.policy.OfficialAdminPolicy.isOfficialAdmin(u.getEmail(), u.getRole()))
                                .orElse(false);
        }

        @jakarta.persistence.PersistenceContext
        private jakarta.persistence.EntityManager entityManager;

        @Value("${ai.base-url:http://localhost:8000}")
        private String aiBaseUrl;

        @Value("${ai.timeout.connect:10000}")
        private int aiConnectTimeout;

        @Value("${ai.timeout.read:120000}")
        private int aiReadTimeout;

        private final ObjectMapper objectMapper = new ObjectMapper();

        /** Import limits for every account (size, type, image size, words, recognition concurrency); absent in slim tests. */
        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private ReadingImportGuard importGuard;

        private ReadingImportGuard guard() {
                if (importGuard == null) importGuard = new ReadingImportGuard();
                return importGuard;
        }

        @Transactional
        public ReadingMaterialResponse addMaterial(ReadingMaterialRequest request, Long userId) {
                ReadingImportGuard.checkText(request.getContentText());
                int wordCount = 0;
                if (request.getContentText() != null && !request.getContentText().isBlank()) {
                        wordCount = request.getContentText().trim().split("\\s+").length;
                }

                ReadingMaterial material = ReadingMaterial.builder()
                                .title(request.getTitle())
                                .sourceUrl(request.getSourceUrl())
                                .materialType(request.getMaterialType())
                                .contentText(request.getContentText())
                                .fileUrl(request.getFileUrl())
                                .wordCount(wordCount)
                                .difficultyLevel("B2")
                                .createdAt(LocalDateTime.now())
                                .ownerUserId(userId)
                                .isSystem(false)
                                .build();

                ReadingMaterial saved = readingMaterialRepository.save(material);

                return toResponse(saved);
        }

        @Transactional
        public ReadingMaterialResponse addMaterial(ReadingMaterialRequest request) {
                return addMaterial(request, null);
        }

        @Transactional(readOnly = true)
        public List<ReadingMaterialResponse> getAllMaterials(Long userId) {
                return readingMaterialRepository.findVisibleToUser(userId).stream()
                                .map(this::toResponse)
                                .collect(Collectors.toList());
        }

        @Transactional(readOnly = true)
        public List<ReadingMaterialResponse> getAllMaterials() {
                return getAllMaterials(null);
        }

        @Transactional(readOnly = true)
        public ReadingMaterialResponse getMaterialById(Long id, Long userId) {
                ReadingMaterial material = readingMaterialRepository.findByIdAndVisibleToUser(id, userId)
                                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: " + id));
                return toResponse(material, true);
        }

        @Transactional
        public void deleteMaterial(Long id, Long userId) {
                log.info("Deleting reading material id: {} by userId: {}", id, userId);
                ReadingMaterial material = readingMaterialRepository.findById(id)
                                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: " + id));

                boolean isAdmin = isOfficialAdmin(userId);

                if (!isAdmin && (material.getOwnerUserId() == null || !material.getOwnerUserId().equals(userId))) {
                        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: " + id);
                }

                if (material.isSystem() && !isAdmin) {
                        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: " + id);
                }

                if (entityManager != null) {
                        // 1. Delete highlights on this reading material
                        entityManager.createNativeQuery("DELETE FROM document_highlights WHERE reading_material_id = :id")
                                        .setParameter("id", id)
                                        .executeUpdate();

                        // 2. Delete user reading progress on this reading material
                        entityManager.createNativeQuery("DELETE FROM user_reading_progress WHERE reading_material_id = :id")
                                        .setParameter("id", id)
                                        .executeUpdate();

                        // 3. Delete user contextual vocabulary history for this reading material
                        entityManager.createNativeQuery("DELETE FROM reading_contextual_vocabulary_history WHERE reading_material_id = :id")
                                        .setParameter("id", id)
                                        .executeUpdate();

                        // 4. Delete contextual explanations generated for this reading material
                        entityManager.createNativeQuery("DELETE FROM reading_contextual_explanations WHERE reading_material_id = :id")
                                        .setParameter("id", id)
                                        .executeUpdate();

                        // 5. Nullify foreign key reference in vocabulary course words if any
                        entityManager.createNativeQuery("UPDATE vocabulary_course_words SET source_material_id = NULL WHERE source_material_id = :id")
                                        .setParameter("id", id)
                                        .executeUpdate();

                        // 6. Delete reading material directly via native query
                        readingMaterialRepository.deleteByIdNative(id);
                } else {
                        readingMaterialRepository.delete(material);
                }
                log.info("Successfully deleted reading material id: {}", id);
        }

        @Transactional(propagation = Propagation.NOT_SUPPORTED)
        public Map<String, Object> extractFile(MultipartFile file, String title) {
                return extractFileInternal(file, title, null);
        }

        /**
         * Sends a checked document to the AI host's text recognition. Limits (ReadingImportGuard) apply to every account:
         * type + real signature, size and image dimensions before sending, recognition slots (server-wide and per account),
         * the host's own page limits, and at most 10,000 words of extracted text.
         */
        @Transactional(propagation = Propagation.NOT_SUPPORTED)
        public Map<String, Object> extractFile(MultipartFile file, String title, Long userId) {
                return extractFileInternal(file, title, userId);
        }

        private Map<String, Object> extractFileInternal(MultipartFile file, String title, Long userId) {
                if (file == null || file.isEmpty()) {
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tệp tải lên không được để trống.");
                }

                if (title == null || title.isBlank()) {
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Tiêu đề tài liệu không được để trống.");
                }

                String originalFilename = file.getOriginalFilename();
                String fileExt = "";
                if (originalFilename != null && originalFilename.lastIndexOf('.') != -1) {
                        fileExt = originalFilename.substring(originalFilename.lastIndexOf('.')).toLowerCase();
                }

                boolean isPdf = ".pdf".equals(fileExt);
                boolean isImage = ".png".equals(fileExt) || ".jpg".equals(fileExt) || ".jpeg".equals(fileExt);

                if (!isPdf && !isImage) {
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Định dạng tệp không được hỗ trợ. Vui lòng tải lên tệp PDF, PNG hoặc JPG.");
                }
                guard().preflight(file);
                try (ReadingImportGuard.Permit permit = guard().enter(userId)) {
                        Map<String, Object> result;
                        try {
                                result = recognize(file, originalFilename, isPdf);
                        } catch (RecognitionNotSent notSent) {
                                permit.notSent(); // the host was never reached: the day's upload is not counted
                                throw notSent;
                        }
                        ReadingImportGuard.checkText((String) result.get("extracted_text"));
                        permit.succeeded();
                        return result;
                }
        }

        /** The document never reached the recognition host (connection refused, unknown host, connect timeout). */
        static final class RecognitionNotSent extends ResponseStatusException {
                RecognitionNotSent() {
                        super(HttpStatus.SERVICE_UNAVAILABLE, "Dịch vụ nhận dạng văn bản hiện không khả dụng. Vui lòng thử lại sau.");
                }
        }

        private static boolean notSent(Throwable cause) {
                if (cause instanceof java.net.ConnectException || cause instanceof java.net.UnknownHostException
                                || cause instanceof java.net.NoRouteToHostException) return true;
                return cause instanceof java.net.SocketTimeoutException && cause.getMessage() != null
                                && cause.getMessage().toLowerCase(java.util.Locale.ROOT).contains("connect");
        }

        private Map<String, Object> recognize(MultipartFile file, String originalFilename, boolean isPdf) {

                String baseUrl = (aiBaseUrl != null && !aiBaseUrl.isBlank()) ? aiBaseUrl.replaceAll("/+$", "") : "http://localhost:8000";
                String ocrEndpoint = baseUrl + "/api/v1/ocr/extract";

                SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
                factory.setConnectTimeout(aiConnectTimeout > 0 ? aiConnectTimeout : 10000);
                factory.setReadTimeout(aiReadTimeout > 0 ? aiReadTimeout : 120000);
                RestTemplate restTemplate = new RestTemplate(factory);

                HttpHeaders headers = new HttpHeaders();
                headers.setContentType(MediaType.MULTIPART_FORM_DATA);

                MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
                try {
                        final String uploadName = (originalFilename != null && !originalFilename.isBlank())
                                        ? originalFilename
                                        : (isPdf ? "upload.pdf" : "upload.png");
                        ByteArrayResource fileAsResource = new ByteArrayResource(file.getBytes()) {
                                @Override
                                public String getFilename() {
                                        return uploadName;
                                }
                        };
                        body.add("file", fileAsResource);
                } catch (IOException e) {
                        log.error("Failed to read uploaded file bytes for {}: {}", originalFilename, e.getMessage());
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Không thể đọc tệp đã tải lên. Vui lòng thử lại.");
                }

                HttpEntity<MultiValueMap<String, Object>> requestEntity = new HttpEntity<>(body, headers);

                ResponseEntity<Map> response;
                try {
                        response = restTemplate.postForEntity(ocrEndpoint, requestEntity, Map.class);
                } catch (org.springframework.web.client.ResourceAccessException e) {
                        log.error("Failed to reach OCR service at {}: {}", ocrEndpoint, e.getMessage());
                        if (notSent(e.getCause())) throw new RecognitionNotSent();
                        if (e.getCause() instanceof java.net.SocketTimeoutException) {
                                throw new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, "Xử lý nhận dạng văn bản quá thời gian chờ. Vui lòng thử lại với tệp nhỏ hơn.");
                        }
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Dịch vụ nhận dạng văn bản hiện không khả dụng. Vui lòng thử lại sau.");
                } catch (org.springframework.web.client.HttpStatusCodeException e) {
                        log.error("OCR service returned HTTP status {} from {}: {}", e.getStatusCode(), ocrEndpoint, e.getResponseBodyAsString());
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Dịch vụ nhận dạng văn bản hiện không khả dụng. Vui lòng thử lại sau.");
                } catch (Exception e) {
                        log.error("Unexpected error calling OCR service at {}: {}", ocrEndpoint, e.getMessage(), e);
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Không thể xử lý tài liệu lúc này. Vui lòng thử lại sau.");
                }

                Map<String, Object> responseBody = response != null ? response.getBody() : null;
                if (responseBody == null || !Boolean.TRUE.equals(responseBody.get("success"))) {
                        String errorMsg = responseBody != null && responseBody.get("error") != null
                                        ? String.valueOf(responseBody.get("error"))
                                        : "Unknown OCR error";
                        log.warn("OCR service processing failed for {}: {}", originalFilename, errorMsg);
                        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, ReadingImportGuard.hostRefusal(errorMsg));
                }

                String extractedText = (String) responseBody.get("extracted_text");
                if (extractedText == null || extractedText.isBlank()) {
                        log.warn("OCR service returned empty text for {}", originalFilename);
                        throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Không thể nhận dạng văn bản từ tài liệu này. Vui lòng kiểm tra lại độ rõ nét hoặc định dạng tệp.");
                }

                return responseBody;
        }

        @Transactional(propagation = Propagation.NOT_SUPPORTED)
        public ReadingMaterialResponse processAndSaveFile(MultipartFile file, Long userId, String title) {
                // Phase 1 (outside any DB transaction): validate via ReadingImportGuard and run OCR/PDF extraction (up to 120s).
                Map<String, Object> responseBody = extractFileInternal(file, title, userId);
                String extractedText = (String) responseBody.get("extracted_text");
                String originalFilename = file.getOriginalFilename();
                boolean isPdf = originalFilename != null && originalFilename.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf");
                int wordCount = extractedText.trim().split("\\s+").length;

                @SuppressWarnings("unchecked")
                Map<String, Object> canonicalDocument = responseBody.get("canonical_document") instanceof Map
                                ? (Map<String, Object>) responseBody.get("canonical_document") : null;
                String schemaVersion = canonicalDocument == null ? null : String.valueOf(canonicalDocument.get("schemaVersion"));
                String sourceType = canonicalDocument == null ? null : String.valueOf(canonicalDocument.get("sourceType"));
                String canonicalJson = null;
                try {
                        if (canonicalDocument != null) canonicalJson = objectMapper.writeValueAsString(canonicalDocument);
                } catch (Exception e) {
                        log.warn("OCR returned a document representation that could not be serialized; keeping legacy text only", e);
                }

                ReadingMaterial material = ReadingMaterial.builder()
                                .title(title.trim())
                                .materialType(isPdf ? ReadingMaterial.MaterialType.PDF : ReadingMaterial.MaterialType.CUSTOM)
                                .contentText(extractedText.trim())
                                .wordCount(wordCount)
                                .difficultyLevel("B2")
                                .createdAt(LocalDateTime.now())
                                .ownerUserId(userId)
                                .isSystem(false)
                                .documentSchemaVersion(schemaVersion)
                                .sourceDocumentType(sourceType)
                                .sourceFileName(originalFilename)
                                .canonicalDocument(canonicalJson)
                                .build();

                // Phase 2 (short atomic commit TX): persist material and build full response DTO inside TX.
                return inTx(() -> {
                        ReadingMaterial saved = readingMaterialRepository.save(material);
                        log.info("Successfully imported reading material id={}, title='{}', owner={}, wordCount={}",
                                        saved.getId(), saved.getTitle(), saved.getOwnerUserId(), saved.getWordCount());
                        return toResponse(saved, true);
                });
        }

        @Transactional
        public void saveHighlight(Long userId, HighlightRequest request) {
                User user = userRepository.findById(userId)
                                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found: " + userId));

                ReadingMaterial material = readingMaterialRepository.findByIdAndVisibleToUser(request.getMaterialId(), userId)
                                .orElseThrow(
                                                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: "
                                                                + request.getMaterialId()));

                DocumentHighlight highlight = DocumentHighlight.builder()
                                .user(user)
                                .readingMaterial(material)
                                .highlightedText(request.getHighlightedText())
                                .colorCode(request.getColorCode())
                                .userNote(request.getUserNote())
                                .createdAt(LocalDateTime.now())
                                .build();

                documentHighlightRepository.save(highlight);
        }

        private ReadingMaterialResponse toResponse(ReadingMaterial material) {
                return toResponse(material, false);
        }

        private ReadingMaterialResponse toResponse(ReadingMaterial material, boolean includeDocument) {
                Object document = null;
                if (includeDocument && material.getCanonicalDocument() != null) {
                        try { document = objectMapper.readTree(material.getCanonicalDocument()); }
                        catch (Exception e) { log.warn("Ignoring malformed stored CanonicalDocument for material {}", material.getId()); }
                }
                return ReadingMaterialResponse.builder()
                                .id(material.getId())
                                .title(material.getTitle())
                                .sourceUrl(material.getSourceUrl())
                                .materialType(material.getMaterialType() != null ? material.getMaterialType().name() : null)
                                .contentText(material.getContentText())
                                .wordCount(material.getWordCount())
                                .difficultyLevel(material.getDifficultyLevel())
                                .ownerUserId(material.getOwnerUserId())
                                .sourceName(material.getSourceName())
                                .licenseCode(material.isSystem() && catalogService != null ? catalogService.metadata(material.getSourceUrl(), "licenseCode", "") : "")
                                .attribution(material.isSystem() && catalogService != null ? catalogService.metadata(material.getSourceUrl(), "attribution", "") : "")
                                .topic(material.isSystem() && catalogService != null ? catalogService.metadata(material.getSourceUrl(), "topic", "Other") : "Other")
                                .isSystem(material.isSystem())
                                .documentSchemaVersion(material.getDocumentSchemaVersion())
                                .sourceDocumentType(material.getSourceDocumentType())
                                .sourceFileName(material.getSourceFileName())
                                .hasDocumentRepresentation(material.getCanonicalDocument() != null)
                                .canonicalDocument(document)
                                .build();
        }
}
