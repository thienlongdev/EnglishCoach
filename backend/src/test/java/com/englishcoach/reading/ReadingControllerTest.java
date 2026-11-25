package com.englishcoach.reading;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.reading.controller.ReadingController;
import com.englishcoach.reading.dto.ContextualExplainRequest;
import com.englishcoach.reading.dto.ContextualVocabularyResponse;
import com.englishcoach.reading.dto.ParagraphExtractRequest;
import com.englishcoach.reading.service.ReadingContextualService;
import com.englishcoach.reading.service.ReadingService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import com.englishcoach.common.exception.GlobalExceptionHandler;
import com.englishcoach.reading.dto.ReadingMaterialResponse;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@ExtendWith(MockitoExtension.class)
class ReadingControllerTest {

    @Mock
    private ReadingService readingService;

    @Mock
    private ReadingContextualService contextualService;

    @InjectMocks
    private ReadingController readingController;

    private MockMvc mockMvc;
    private ObjectMapper objectMapper = new ObjectMapper();
    private UserDetailsImpl userDetails;

    @BeforeEach
    void setUp() {
        User user = User.builder()
                .id(42L)
                .email("test@englishcoach.com")
                .name("Test User")
                .role(Role.ROLE_USER)
                .build();
        userDetails = UserDetailsImpl.build(user);

        HandlerMethodArgumentResolver principalResolver = new HandlerMethodArgumentResolver() {
            @Override
            public boolean supportsParameter(MethodParameter parameter) {
                return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            @Override
            public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                          NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
                return userDetails;
            }
        };

        mockMvc = MockMvcBuilders.standaloneSetup(readingController)
                .setCustomArgumentResolvers(principalResolver)
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @Test
    @DisplayName("Controller: POST /api/v1/reading/explain-context returns 200 with contextual response")
    void testExplainContext_Success() {
        ContextualExplainRequest request = new ContextualExplainRequest(
                "insulting",
                "His crime was insulting an important Hindu festival called Nyepi.",
                10L,
                "Balinese Traditions"
        );

        ContextualVocabularyResponse response = ContextualVocabularyResponse.builder()
                .id(1L)
                .text("insulting")
                .lemma("insult")
                .pos("verb")
                .ipa("/ɪnˈsʌltɪŋ/")
                .cefr("B2")
                .meaningInContext("thể hiện sự thiếu tôn trọng")
                .sentence("His crime was insulting an important Hindu festival called Nyepi.")
                .collocations(List.of(new ContextualVocabularyResponse.CollocationItem("deeply insulting", "cực kỳ xúc phạm")))
                .readingMaterialId(10L)
                .build();

        when(contextualService.explainAndSave(eq(42L), any(ContextualExplainRequest.class)))
                .thenReturn(response);

        var result = readingController.explainContext(userDetails, request);
        org.assertj.core.api.Assertions.assertThat(result.getStatusCode().is2xxSuccessful()).isTrue();
        org.assertj.core.api.Assertions.assertThat(result.getBody().getText()).isEqualTo("insulting");
        org.assertj.core.api.Assertions.assertThat(result.getBody().getCefr()).isEqualTo("B2");
    }

    @Test
    @DisplayName("Controller: POST /api/v1/reading/extract-contextual-vocabulary returns 200 with list of extracted vocabulary")
    void testExtractContextualVocabulary_Success() {
        ParagraphExtractRequest request = new ParagraphExtractRequest(
                "His crime was insulting an important Hindu festival called Nyepi. He later expressed deep regret for breaking the sacred rules.",
                10L,
                "Balinese Traditions",
                10
        );

        ContextualVocabularyResponse item1 = ContextualVocabularyResponse.builder()
                .id(1L)
                .text("insulting")
                .cefr("B2")
                .meaningInContext("xúc phạm")
                .readingMaterialId(10L)
                .build();

        ContextualVocabularyResponse item2 = ContextualVocabularyResponse.builder()
                .id(2L)
                .text("deep regret")
                .cefr("B2")
                .meaningInContext("sự hối tiếc sâu sắc")
                .readingMaterialId(10L)
                .build();

        when(contextualService.extractAndSaveBatch(eq(42L), any(ParagraphExtractRequest.class)))
                .thenReturn(List.of(item1, item2));

        var result = readingController.extractContextualVocabulary(userDetails, request);
        org.assertj.core.api.Assertions.assertThat(result.getStatusCode().is2xxSuccessful()).isTrue();
        org.assertj.core.api.Assertions.assertThat(result.getBody()).hasSize(2);
        org.assertj.core.api.Assertions.assertThat(result.getBody().get(0).getText()).isEqualTo("insulting");
        org.assertj.core.api.Assertions.assertThat(result.getBody().get(1).getText()).isEqualTo("deep regret");
    }

    @Test
    @DisplayName("Controller: GET /api/v1/reading/materials/{id}/vocabulary-history returns history for material")
    void testGetVocabularyHistory_Success() {
        ContextualVocabularyResponse item = ContextualVocabularyResponse.builder()
                .id(101L)
                .text("sacred")
                .cefr("B2")
                .meaningInContext("thiêng liêng")
                .readingMaterialId(10L)
                .build();

        when(contextualService.getHistory(42L, 10L)).thenReturn(List.of(item));

        var result = readingController.getVocabularyHistory(userDetails, 10L);
        org.assertj.core.api.Assertions.assertThat(result.getStatusCode().is2xxSuccessful()).isTrue();
        org.assertj.core.api.Assertions.assertThat(result.getBody()).hasSize(1);
        org.assertj.core.api.Assertions.assertThat(result.getBody().get(0).getText()).isEqualTo("sacred");
    }

    @Test
    @DisplayName("Controller: DELETE /api/v1/reading/vocabulary-history/{id} deletes entry")
    void testDeleteVocabularyEntry_Success() {
        var result = readingController.deleteVocabularyEntry(userDetails, 101L);
        org.assertj.core.api.Assertions.assertThat(result.getStatusCode().value()).isEqualTo(204);
        verify(contextualService).deleteEntry(42L, 101L);
    }

    @Test
    @DisplayName("Controller: Unauthenticated access throws AccessDeniedException")
    void testUnauthenticated_ThrowsAccessDenied() {
        ContextualExplainRequest request = new ContextualExplainRequest("test", "sentence", 1L, "title");
        assertThatThrownBy(() -> readingController.explainContext(null, request))
                .isInstanceOf(AccessDeniedException.class);

        assertThatThrownBy(() -> readingController.getVocabularyHistory(null, 1L))
                .isInstanceOf(AccessDeniedException.class);

        assertThatThrownBy(() -> readingController.deleteVocabularyEntry(null, 1L))
                .isInstanceOf(AccessDeniedException.class);
    }

    @Test
    @DisplayName("HTTP Contract: GET /api/v1/reading/materials/{id} returns 404 for foreign or quarantined material")
    void testGetMaterialById_NotFound() throws Exception {
        when(readingService.getMaterialById(eq(999L), any()))
                .thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: 999"));

        mockMvc.perform(get("/api/v1/reading/materials/999"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.status").value(404))
                .andExpect(jsonPath("$.message").value("Reading material not found: 999"));
    }

    @Test
    @DisplayName("HTTP Contract: DELETE /api/v1/reading/materials/{id} returns 404 for foreign or quarantined material")
    void testDeleteMaterial_NotFound() throws Exception {
        doThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: 999"))
                .when(readingService).deleteMaterial(eq(999L), any());

        mockMvc.perform(delete("/api/v1/reading/materials/999"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.status").value(404))
                .andExpect(jsonPath("$.message").value("Reading material not found: 999"));
    }

    @Test
    @DisplayName("HTTP Contract: PUT/PATCH /api/v1/reading/materials/{id} returns 405 (never 500)")
    void testMaterialUpdate_NotAllowed() throws Exception {
        mockMvc.perform(put("/api/v1/reading/materials/999"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.status").value(405));

        mockMvc.perform(patch("/api/v1/reading/materials/999"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.status").value(405));
    }

    @Test
    @DisplayName("HTTP Contract: GET /api/v1/reading/materials/{id} returns 200 for owned material")
    void testGetMaterialById_Own_Success() throws Exception {
        when(readingService.getMaterialById(eq(501L), any()))
                .thenReturn(ReadingMaterialResponse.builder().id(501L).title("Own Reading").build());

        mockMvc.perform(get("/api/v1/reading/materials/501"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(501))
                .andExpect(jsonPath("$.title").value("Own Reading"));
    }

    @Test
    @DisplayName("HTTP Contract: DELETE /api/v1/reading/materials/{id} returns 204 for owned material")
    void testDeleteMaterial_Own_Success() throws Exception {
        mockMvc.perform(delete("/api/v1/reading/materials/501"))
                .andExpect(status().isNoContent());

        verify(readingService).deleteMaterial(501L, 42L);
    }

    @Test
    @DisplayName("Controller: POST /api/v1/reading/materials/upload with authenticated user returns 201")
    void testUploadMaterial_Success() {
        org.springframework.mock.web.MockMultipartFile file = new org.springframework.mock.web.MockMultipartFile(
                "file", "test.png", "image/png", "dummy".getBytes()
        );
        ReadingMaterialResponse expectedResponse = ReadingMaterialResponse.builder()
                .id(100L)
                .title("Uploaded Material")
                .materialType("CUSTOM")
                .contentText("Sample extracted text")
                .wordCount(3)
                .build();

        when(readingService.processAndSaveFile(file, 42L, "Uploaded Material"))
                .thenReturn(expectedResponse);

        var result = readingController.uploadMaterial(file, "Uploaded Material", userDetails);
        org.assertj.core.api.Assertions.assertThat(result.getStatusCode().value()).isEqualTo(201);
        org.assertj.core.api.Assertions.assertThat(result.getBody()).isNotNull();
        org.assertj.core.api.Assertions.assertThat(result.getBody().getTitle()).isEqualTo("Uploaded Material");
        verify(readingService).processAndSaveFile(file, 42L, "Uploaded Material");
    }

    @Test
    @DisplayName("Controller: POST /api/v1/reading/materials/upload with unauthenticated user throws AccessDeniedException")
    void testUploadMaterial_Unauthenticated() {
        org.springframework.mock.web.MockMultipartFile file = new org.springframework.mock.web.MockMultipartFile(
                "file", "test.png", "image/png", "dummy".getBytes()
        );
        assertThatThrownBy(() -> readingController.uploadMaterial(file, "Uploaded Material", null))
                .isInstanceOf(AccessDeniedException.class);
        verifyNoInteractions(readingService);
    }
}
