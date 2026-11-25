package com.englishcoach.user.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.user.dto.UpdateUserProfileRequest;
import com.englishcoach.user.dto.UserProfileDto;
import com.englishcoach.user.entity.UserProfile;
import com.englishcoach.user.repository.UserProfileRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class UserProfileServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private UserProfileRepository userProfileRepository;

    @Mock
    private AuthIdentityRepository authIdentityRepository;

    @Mock
    private AvatarStorageService avatarStorageService;

    private UserProfileService userProfileService;

    private User testUser;

    @BeforeEach
    void setUp() {
        userProfileService = new UserProfileService(
                userRepository,
                userProfileRepository,
                authIdentityRepository,
                avatarStorageService
        );

        testUser = User.builder()
                .id(1L)
                .email("learner@englishcoach.com")
                .name("Alex Johnson")
                .password("$2a$10$hashedpassword")
                .role(Role.ROLE_USER)
                .credentialStatus("ACTIVE")
                .accountStatus("ACTIVE")
                .createdAt(LocalDateTime.now())
                .build();
    }

    @Test
    @DisplayName("Should return sensible defaults with fallback to User.name when profile row is absent")
    void testGetProfile_AbsentProfile_ReturnsDefaultsWithoutMutatingDb() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));
        when(userProfileRepository.findById(1L)).thenReturn(Optional.empty());
        when(authIdentityRepository.existsByUserIdAndProvider(1L, "GOOGLE")).thenReturn(false);

        UserProfileDto profile = userProfileService.getProfile(1L);

        assertThat(profile.email()).isEqualTo("learner@englishcoach.com");
        assertThat(profile.accountName()).isEqualTo("Alex Johnson");
        assertThat(profile.displayName()).isEqualTo("Alex Johnson");
        assertThat(profile.phone()).isNull();
        assertThat(profile.city()).isNull();
        assertThat(profile.province()).isNull();
        assertThat(profile.avatarPresent()).isFalse();
        assertThat(profile.canChangePassword()).isTrue();
        assertThat(profile.authMethods()).contains("CREDENTIALS");

        verify(userProfileRepository, never()).save(any());
    }

    @Test
    @DisplayName("Google-only account should have canChangePassword = false")
    void testGetProfile_GoogleOnlyUser_CanChangePasswordFalse() {
        User googleUser = User.builder()
                .id(2L)
                .email("google.learner@gmail.com")
                .name("Google Learner")
                .password(null)
                .role(Role.ROLE_USER)
                .credentialStatus("NONE")
                .accountStatus("ACTIVE")
                .createdAt(LocalDateTime.now())
                .build();

        when(userRepository.findById(2L)).thenReturn(Optional.of(googleUser));
        when(userProfileRepository.findById(2L)).thenReturn(Optional.empty());
        when(authIdentityRepository.existsByUserIdAndProvider(2L, "GOOGLE")).thenReturn(true);

        UserProfileDto profile = userProfileService.getProfile(2L);

        assertThat(profile.canChangePassword()).isFalse();
        assertThat(profile.authMethods()).contains("GOOGLE");
        assertThat(profile.authMethods()).doesNotContain("CREDENTIALS");
    }

    @Test
    @DisplayName("First update creates user_profiles row")
    void testUpdateProfile_FirstTime_CreatesRow() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));
        when(userProfileRepository.findById(1L)).thenReturn(Optional.empty());
        when(userProfileRepository.save(any(UserProfile.class))).thenAnswer(invocation -> invocation.getArgument(0));

        UpdateUserProfileRequest request = new UpdateUserProfileRequest(
                "Alex The Great",
                "+84901234567",
                "Ho Chi Minh",
                "Ho Chi Minh"
        );

        UserProfileDto result = userProfileService.updateProfile(1L, request);

        ArgumentCaptor<UserProfile> captor = ArgumentCaptor.forClass(UserProfile.class);
        verify(userProfileRepository).save(captor.capture());
        UserProfile saved = captor.getValue();

        assertThat(saved.getUserId()).isEqualTo(1L);
        assertThat(saved.getDisplayName()).isEqualTo("Alex The Great");
        assertThat(saved.getPhone()).isEqualTo("+84901234567");
        assertThat(saved.getCity()).isEqualTo("Ho Chi Minh");
        assertThat(saved.getProvince()).isEqualTo("Ho Chi Minh");

        assertThat(result.displayName()).isEqualTo("Alex The Great");
        assertThat(result.phone()).isEqualTo("+84901234567");
    }

    @Test
    @DisplayName("Later update modifies existing user_profiles row")
    void testUpdateProfile_ExistingProfile_UpdatesRow() {
        UserProfile existing = UserProfile.builder()
                .userId(1L)
                .displayName("Old Nickname")
                .phone("+84999999999")
                .build();

        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));
        when(userProfileRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(userProfileRepository.save(any(UserProfile.class))).thenAnswer(invocation -> invocation.getArgument(0));

        UpdateUserProfileRequest request = new UpdateUserProfileRequest(
                "New Nickname",
                "+84912345678",
                "Da Nang",
                "Da Nang"
        );

        UserProfileDto result = userProfileService.updateProfile(1L, request);

        assertThat(existing.getDisplayName()).isEqualTo("New Nickname");
        assertThat(existing.getPhone()).isEqualTo("+84912345678");
        assertThat(existing.getCity()).isEqualTo("Da Nang");
        assertThat(result.displayName()).isEqualTo("New Nickname");
    }

    @Test
    @DisplayName("Should reject blank-after-trim display name")
    void testUpdateProfile_BlankDisplayName_ThrowsException() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));

        UpdateUserProfileRequest request = new UpdateUserProfileRequest("    ", null, null, null);

        assertThatThrownBy(() -> userProfileService.updateProfile(1L, request))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Display name cannot be blank");
    }

    @Test
    @DisplayName("Should reject control characters in display name")
    void testUpdateProfile_ControlCharacters_ThrowsException() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));

        UpdateUserProfileRequest request = new UpdateUserProfileRequest("Bad\nName", null, null, null);

        assertThatThrownBy(() -> userProfileService.updateProfile(1L, request))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Display name contains invalid characters");
    }

    @Test
    @DisplayName("Should reject invalid phone format")
    void testUpdateProfile_InvalidPhone_ThrowsException() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));

        UpdateUserProfileRequest request = new UpdateUserProfileRequest("Valid Name", "not-a-phone-number", null, null);

        assertThatThrownBy(() -> userProfileService.updateProfile(1L, request))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid phone number format");
    }

    @Test
    @DisplayName("Delete avatar should delete file and clear persisted key")
    void testDeleteAvatar_ClearsReference() {
        UserProfile profile = UserProfile.builder()
                .userId(1L)
                .avatarStorageKey("1/avatar.png")
                .build();

        when(userProfileRepository.findById(1L)).thenReturn(Optional.of(profile));

        userProfileService.deleteAvatar(1L);

        verify(avatarStorageService).deleteAvatar(1L);
        assertThat(profile.getAvatarStorageKey()).isNull();
        verify(userProfileRepository).save(profile);
    }

    @Test
    @DisplayName("Should accept valid historical date of birth and null date of birth")
    void testUpdateProfile_ValidDateOfBirth_Accepted() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));
        when(userProfileRepository.findById(1L)).thenReturn(Optional.empty());
        when(userProfileRepository.save(any(UserProfile.class))).thenAnswer(invocation -> invocation.getArgument(0));

        LocalDate dob = LocalDate.of(1998, 8, 15);
        UpdateUserProfileRequest request = new UpdateUserProfileRequest(
                "Alex",
                null,
                null,
                "Hanoi",
                dob
        );

        UserProfileDto result = userProfileService.updateProfile(1L, request);

        assertThat(result.dateOfBirth()).isEqualTo(dob);
        assertThat(result.province()).isEqualTo("Hanoi");
    }

    @Test
    @DisplayName("Should reject future date of birth")
    void testUpdateProfile_FutureDateOfBirth_ThrowsException() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));

        LocalDate futureDob = LocalDate.now().plusDays(1);
        UpdateUserProfileRequest request = new UpdateUserProfileRequest(
                "Alex",
                null,
                null,
                "Hanoi",
                futureDob
        );

        assertThatThrownBy(() -> userProfileService.updateProfile(1L, request))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Date of birth cannot be in the future");
    }

    @Test
    @DisplayName("Legacy city fallback: if province is null/empty but city exists, province returns city")
    void testGetProfile_LegacyCityFallback_ReturnsCityAsProvince() {
        UserProfile existing = UserProfile.builder()
                .userId(1L)
                .displayName("Alex")
                .city("Ha Noi")
                .province(null)
                .build();

        when(userRepository.findById(1L)).thenReturn(Optional.of(testUser));
        when(userProfileRepository.findById(1L)).thenReturn(Optional.of(existing));

        UserProfileDto profile = userProfileService.getProfile(1L);

        assertThat(profile.province()).isEqualTo("Ha Noi");
        assertThat(profile.city()).isEqualTo("Ha Noi");
    }
}
