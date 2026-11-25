package com.englishcoach.listening.controller;

import com.englishcoach.listening.dto.ListeningLibraryItemDto;
import com.englishcoach.listening.service.ListeningService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class ListeningControllerTest {

    @Mock
    private ListeningService listeningService;

    @InjectMocks
    private ListeningController listeningController;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(listeningController).build();
    }

    @Test
    @DisplayName("GET /api/v1/listening/library returns shared catalog with system items")
    void testGetSharedLibrary() throws Exception {
        ListeningLibraryItemDto item1 = ListeningLibraryItemDto.builder()
                .id(11L)
                .title("Sample Lesson")
                .channel("TED")
                .topic("Ideas & Talks")
                .level("B2")
                .accent("American")
                .durationSeconds(300)
                .thumbnail("https://i.ytimg.com/vi/abc/hqdefault.jpg")
                .youtubeVideoId("abc12345678")
                .practiceAvailable(true)
                .hasTranscript(true)
                .build();

        ListeningLibraryItemDto item2 = ListeningLibraryItemDto.builder()
                .id(23L)
                .title("Watch Only Lesson")
                .channel("SciShow")
                .topic("Science & Tech")
                .level("B2")
                .accent("American")
                .durationSeconds(null)
                .thumbnail("https://i.ytimg.com/vi/def/hqdefault.jpg")
                .youtubeVideoId("def12345678")
                .practiceAvailable(false)
                .hasTranscript(false)
                .build();

        when(listeningService.getSharedLibrary()).thenReturn(List.of(item1, item2));

        mockMvc.perform(get("/api/v1/listening/library").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].id").value(11))
                .andExpect(jsonPath("$[0].title").value("Sample Lesson"))
                .andExpect(jsonPath("$[0].practiceAvailable").value(true))
                .andExpect(jsonPath("$[0].hasTranscript").value(true))
                .andExpect(jsonPath("$[1].id").value(23))
                .andExpect(jsonPath("$[1].practiceAvailable").value(false))
                .andExpect(jsonPath("$[1].hasTranscript").value(false))
                .andExpect(jsonPath("$[1].durationSeconds").doesNotExist());
    }

    @Test
    @DisplayName("GET /api/v1/listening/library/categories returns category boxes")
    void testGetLibraryCategories() throws Exception {
        com.englishcoach.listening.dto.ListeningCategoryDto cat1 = com.englishcoach.listening.dto.ListeningCategoryDto.builder()
                .topic("Science & Tech")
                .count(5)
                .items(List.of())
                .build();
        com.englishcoach.listening.dto.ListeningCategoryDto cat2 = com.englishcoach.listening.dto.ListeningCategoryDto.builder()
                .topic("Everyday English")
                .count(3)
                .items(List.of())
                .build();

        when(listeningService.getLibraryCategories()).thenReturn(List.of(cat1, cat2));

        mockMvc.perform(get("/api/v1/listening/library/categories").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].topic").value("Science & Tech"))
                .andExpect(jsonPath("$[0].count").value(5))
                .andExpect(jsonPath("$[1].topic").value("Everyday English"))
                .andExpect(jsonPath("$[1].count").value(3));
    }

    @Test
    @DisplayName("GET /api/v1/listening/materials?personalOnly=true calls getPersonalMaterials")
    void testGetPersonalMaterialsOnly() throws Exception {
        com.englishcoach.listening.dto.ListeningMaterialSummaryDto summary = com.englishcoach.listening.dto.ListeningMaterialSummaryDto.builder()
                .id(99L)
                .title("Personal Lesson")
                .topic("Work & Study")
                .cefrLevel("B2")
                .build();

        when(listeningService.getPersonalMaterials(null, null, null, null))
                .thenReturn(List.of(summary));

        mockMvc.perform(get("/api/v1/listening/materials")
                        .param("personalOnly", "true")
                        .contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(1))
                .andExpect(jsonPath("$[0].id").value(99))
                .andExpect(jsonPath("$[0].title").value("Personal Lesson"));
    }

    @Test
    @DisplayName("POST /import binds ownership to the authenticated user and never routes to SYSTEM import")
    void testImportBindsAuthenticatedOwner() {
        com.englishcoach.common.security.UserDetailsImpl userA = new com.englishcoach.common.security.UserDetailsImpl(
                7L, "a@example.com", "pw", java.util.Collections.emptyList());
        com.englishcoach.listening.dto.ImportListeningMaterialRequest request = com.englishcoach.listening.dto.ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .build();
        com.englishcoach.listening.dto.ListeningMaterialDetailDto created = com.englishcoach.listening.dto.ListeningMaterialDetailDto.builder()
                .id(501L)
                .title("Imported")
                .build();
        when(listeningService.importMaterialFromYouTube(request, 7L)).thenReturn(created);

        var response = listeningController.importMaterial(request, userA);

        org.junit.jupiter.api.Assertions.assertEquals(201, response.getStatusCode().value());
        org.junit.jupiter.api.Assertions.assertEquals(501L, response.getBody().getId());
        org.mockito.Mockito.verify(listeningService).importMaterialFromYouTube(request, 7L);
        org.mockito.Mockito.verify(listeningService, org.mockito.Mockito.never()).importSystemMaterial(org.mockito.ArgumentMatchers.any());
    }

    @Test
    @DisplayName("POST /import without authentication is rejected before any import")
    void testImportRequiresAuthentication() {
        com.englishcoach.listening.dto.ImportListeningMaterialRequest request = com.englishcoach.listening.dto.ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .build();

        org.junit.jupiter.api.Assertions.assertThrows(
                org.springframework.security.access.AccessDeniedException.class,
                () -> listeningController.importMaterial(request, null));
        org.mockito.Mockito.verifyNoInteractions(listeningService);
    }

    @Test
    @DisplayName("GET /materials?personalOnly=true scopes by the authenticated principal: User B never receives User A's list")
    void testPersonalMaterialsScopedToPrincipal() {
        com.englishcoach.common.security.UserDetailsImpl userA = new com.englishcoach.common.security.UserDetailsImpl(
                7L, "a@example.com", "pw", java.util.Collections.emptyList());
        com.englishcoach.common.security.UserDetailsImpl userB = new com.englishcoach.common.security.UserDetailsImpl(
                8L, "b@example.com", "pw", java.util.Collections.emptyList());
        com.englishcoach.listening.dto.ListeningMaterialSummaryDto aItem = com.englishcoach.listening.dto.ListeningMaterialSummaryDto.builder()
                .id(501L).title("A private").ownerUserId(7L).isSystem(false).build();
        when(listeningService.getPersonalMaterials(null, null, null, 7L)).thenReturn(List.of(aItem));
        when(listeningService.getPersonalMaterials(null, null, null, 8L)).thenReturn(List.of());

        var aList = listeningController.getMaterials(null, null, null, true, userA).getBody();
        var bList = listeningController.getMaterials(null, null, null, true, userB).getBody();

        org.junit.jupiter.api.Assertions.assertEquals(1, aList.size());
        org.junit.jupiter.api.Assertions.assertTrue(bList.isEmpty());
        org.mockito.Mockito.verify(listeningService).getPersonalMaterials(null, null, null, 8L);
        org.mockito.Mockito.verify(listeningService, org.mockito.Mockito.never()).getAllMaterials(
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }
}
