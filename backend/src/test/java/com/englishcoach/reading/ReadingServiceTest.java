package com.englishcoach.reading;

import com.englishcoach.reading.dto.ReadingMaterialRequest;
import com.englishcoach.reading.dto.ReadingMaterialResponse;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.DocumentHighlightRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.ReadingService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ReadingServiceTest {

    @Mock
    private ReadingMaterialRepository readingMaterialRepository;

    @Mock
    private DocumentHighlightRepository documentHighlightRepository;

    @InjectMocks
    private ReadingService readingService;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(readingService, "aiBaseUrl", "http://127.0.0.1:59999"); // intentionally non-running port for connection tests
        ReflectionTestUtils.setField(readingService, "aiConnectTimeout", 500);
        ReflectionTestUtils.setField(readingService, "aiReadTimeout", 500);
    }

    @Test
    @DisplayName("processAndSaveFile: Null or empty file throws 400 Bad Request")
    void testEmptyFile_ThrowsBadRequest() {
        MockMultipartFile emptyFile = new MockMultipartFile("file", "test.png", "image/png", new byte[0]);

        assertThatThrownBy(() -> readingService.processAndSaveFile(emptyFile, 42L, "Title"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(rse.getReason()).contains("Tệp tải lên không được để trống");
                });

        assertThatThrownBy(() -> readingService.processAndSaveFile(null, 42L, "Title"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    @Test
    @DisplayName("processAndSaveFile: Blank title throws 400 Bad Request")
    void testBlankTitle_ThrowsBadRequest() {
        MockMultipartFile file = new MockMultipartFile("file", "test.png", "image/png", "abc".getBytes());

        assertThatThrownBy(() -> readingService.processAndSaveFile(file, 42L, "   "))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(rse.getReason()).contains("Tiêu đề tài liệu không được để trống");
                });
    }

    @Test
    @DisplayName("processAndSaveFile: Unsupported file extension throws 400 Bad Request")
    void testUnsupportedExtension_ThrowsBadRequest() {
        MockMultipartFile file = new MockMultipartFile("file", "document.docx", "application/octet-stream", "dummy content".getBytes());

        assertThatThrownBy(() -> readingService.processAndSaveFile(file, 42L, "Valid Title"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
                    assertThat(rse.getReason()).contains("Định dạng tệp không được hỗ trợ");
                });
    }

    @Test
    @DisplayName("processAndSaveFile: Unreachable OCR service throws 503 Service Unavailable with Vietnamese message")
    void testOcrUnreachable_Throws503() {
        MockMultipartFile file = new MockMultipartFile("file", "document.pdf", "application/pdf", "%PDF-1.4 dummy pdf content".getBytes());

        assertThatThrownBy(() -> readingService.processAndSaveFile(file, 42L, "Valid Title"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(rse.getReason()).isEqualTo("Dịch vụ nhận dạng văn bản hiện không khả dụng. Vui lòng thử lại sau.");
                });

        verifyNoInteractions(readingMaterialRepository);
    }

    @Test
    @DisplayName("Regression: addMaterial (paste text flow) correctly saves material with ownership")
    void testAddMaterial_PasteTextRegression() {
        ReadingMaterialRequest request = new ReadingMaterialRequest(
                "Pasted Article",
                null,
                ReadingMaterial.MaterialType.CUSTOM,
                "This is a sample text pasted by the user.",
                null
        );

        ReadingMaterial savedEntity = ReadingMaterial.builder()
                .id(200L)
                .title("Pasted Article")
                .contentText("This is a sample text pasted by the user.")
                .materialType(ReadingMaterial.MaterialType.CUSTOM)
                .wordCount(9)
                .difficultyLevel("B2")
                .ownerUserId(42L)
                .isSystem(false)
                .build();

        when(readingMaterialRepository.save(any(ReadingMaterial.class))).thenReturn(savedEntity);

        ReadingMaterialResponse response = readingService.addMaterial(request, 42L);

        assertThat(response).isNotNull();
        assertThat(response.getId()).isEqualTo(200L);
        assertThat(response.getTitle()).isEqualTo("Pasted Article");
        assertThat(response.getWordCount()).isEqualTo(9);

        ArgumentCaptor<ReadingMaterial> captor = ArgumentCaptor.forClass(ReadingMaterial.class);
        verify(readingMaterialRepository).save(captor.capture());
        ReadingMaterial captured = captor.getValue();
        assertThat(captured.getOwnerUserId()).isEqualTo(42L);
        assertThat(captured.isSystem()).isFalse();
        assertThat(captured.getMaterialType()).isEqualTo(ReadingMaterial.MaterialType.CUSTOM);
    }
}
