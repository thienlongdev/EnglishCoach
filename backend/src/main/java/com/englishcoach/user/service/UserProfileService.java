package com.englishcoach.user.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.user.dto.UpdateUserProfileRequest;
import com.englishcoach.user.dto.UserProfileDto;
import com.englishcoach.user.entity.UserProfile;
import com.englishcoach.user.repository.UserProfileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
@Slf4j
public class UserProfileService {

    private static final Pattern PHONE_PATTERN = Pattern.compile("^[+]?[0-9\\s\\-()]{6,32}$");

    private final UserRepository userRepository;
    private final UserProfileRepository userProfileRepository;
    private final AuthIdentityRepository authIdentityRepository;
    private final AvatarStorageService avatarStorageService;

    @Transactional(readOnly = true)
    public UserProfileDto getProfile(Long userId) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        UserProfile profile = userProfileRepository.findById(userId).orElse(null);

        return buildProfileDto(user, profile);
    }

    @Transactional
    public UserProfileDto updateProfile(Long userId, UpdateUserProfileRequest request) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        // Validate server-side
        String sanitizedDisplayName = null;
        if (request.displayName() != null) {
            sanitizedDisplayName = request.displayName().trim();
            if (sanitizedDisplayName.isEmpty()) {
                throw new IllegalArgumentException("Display name cannot be blank");
            }
            if (sanitizedDisplayName.length() > 100) {
                throw new IllegalArgumentException("Display name cannot exceed 100 characters");
            }
            if (containsControlCharacters(sanitizedDisplayName)) {
                throw new IllegalArgumentException("Display name contains invalid characters");
            }
        }

        String sanitizedPhone = null;
        if (request.phone() != null) {
            sanitizedPhone = request.phone().trim();
            if (!sanitizedPhone.isEmpty()) {
                if (sanitizedPhone.length() > 32) {
                    throw new IllegalArgumentException("Phone number cannot exceed 32 characters");
                }
                if (containsControlCharacters(sanitizedPhone) || !PHONE_PATTERN.matcher(sanitizedPhone).matches()) {
                    throw new IllegalArgumentException("Invalid phone number format");
                }
            } else {
                sanitizedPhone = null;
            }
        }

        String sanitizedCity = null;
        if (request.city() != null) {
            sanitizedCity = request.city().trim();
            if (!sanitizedCity.isEmpty()) {
                if (sanitizedCity.length() > 100) {
                    throw new IllegalArgumentException("City cannot exceed 100 characters");
                }
                if (containsControlCharacters(sanitizedCity)) {
                    throw new IllegalArgumentException("City contains invalid characters");
                }
            } else {
                sanitizedCity = null;
            }
        }

        String sanitizedProvince = null;
        if (request.province() != null) {
            sanitizedProvince = request.province().trim();
            if (!sanitizedProvince.isEmpty()) {
                if (sanitizedProvince.length() > 100) {
                    throw new IllegalArgumentException("Province cannot exceed 100 characters");
                }
                if (containsControlCharacters(sanitizedProvince)) {
                    throw new IllegalArgumentException("Province contains invalid characters");
                }
            } else {
                sanitizedProvince = null;
            }
        }

        LocalDate dateOfBirth = request.dateOfBirth();
        if (dateOfBirth != null && dateOfBirth.isAfter(LocalDate.now())) {
            throw new IllegalArgumentException("Date of birth cannot be in the future");
        }

        // Canonical single location field: province.
        // Fallback to city if province is null/empty but city is provided.
        String effectiveProvince = sanitizedProvince;
        if ((effectiveProvince == null || effectiveProvince.isEmpty()) && (sanitizedCity != null && !sanitizedCity.isEmpty())) {
            effectiveProvince = sanitizedCity;
        }

        // Upsert user_profiles row
        UserProfile profile = userProfileRepository.findById(userId).orElse(null);
        if (profile == null) {
            profile = UserProfile.builder()
                    .userId(userId)
                    .displayName(sanitizedDisplayName)
                    .phone(sanitizedPhone)
                    .city(sanitizedCity)
                    .province(effectiveProvince)
                    .dateOfBirth(dateOfBirth)
                    .build();
        } else {
            if (request.displayName() != null) {
                profile.setDisplayName(sanitizedDisplayName);
            }
            profile.setPhone(sanitizedPhone);
            if (sanitizedCity != null) {
                profile.setCity(sanitizedCity);
            }
            if (effectiveProvince != null || request.province() != null) {
                profile.setProvince(effectiveProvince);
            }
            profile.setDateOfBirth(dateOfBirth);
        }

        profile = userProfileRepository.save(profile);
        log.info("Updated profile for user {}", userId);

        return buildProfileDto(user, profile);
    }

    @Transactional
    public UserProfileDto uploadAvatar(Long userId, MultipartFile file) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        String storageKey = avatarStorageService.storeAvatar(userId, file);

        UserProfile profile = userProfileRepository.findById(userId).orElse(null);
        if (profile == null) {
            profile = UserProfile.builder()
                    .userId(userId)
                    .avatarStorageKey(storageKey)
                    .avatarUpdatedAt(Instant.now())
                    .build();
        } else {
            profile.setAvatarStorageKey(storageKey);
            profile.setAvatarUpdatedAt(Instant.now());
        }

        profile = userProfileRepository.save(profile);
        log.info("Saved avatar reference {} for user {}", storageKey, userId);

        return buildProfileDto(user, profile);
    }

    @Transactional
    public void deleteAvatar(Long userId) {
        if (userId == null) {
            return;
        }

        avatarStorageService.deleteAvatar(userId);

        userProfileRepository.findById(userId).ifPresent(profile -> {
            profile.setAvatarStorageKey(null);
            profile.setAvatarUpdatedAt(Instant.now());
            userProfileRepository.save(profile);
            log.info("Cleared avatar reference for user {}", userId);
        });
    }

    @Transactional(readOnly = true)
    public Resource loadAvatarResource(Long userId) {
        if (userId == null) {
            return null;
        }

        UserProfile profile = userProfileRepository.findById(userId).orElse(null);
        if (profile == null || profile.getAvatarStorageKey() == null || profile.getAvatarStorageKey().isBlank()) {
            return null;
        }

        return avatarStorageService.loadAvatarResource(userId);
    }

    /**
     * Public display name for multiplayer rooms: returns trimmed user name only when non-blank and
     * not an e-mail address so callers never leak private e-mails to opponents.
     */
    @Transactional(readOnly = true)
    public Optional<String> findPublicDisplayName(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        return userRepository.findById(userId)
                .map(User::getName)
                .map(String::trim)
                .filter(name -> !name.isBlank() && !name.contains("@"));
    }

    @Transactional(readOnly = true)
    public Instant getAvatarLastModified(Long userId) {
        if (userId == null) {
            return null;
        }
        return avatarStorageService.getAvatarLastModified(userId);
    }

    private UserProfileDto buildProfileDto(User user, UserProfile profile) {
        String effectiveDisplayName;
        if (profile != null && profile.getDisplayName() != null && !profile.getDisplayName().isBlank()) {
            effectiveDisplayName = profile.getDisplayName();
        } else {
            effectiveDisplayName = user.getName();
        }

        String phone = profile != null ? profile.getPhone() : null;
        String city = profile != null ? profile.getCity() : null;
        String province = profile != null ? profile.getProvince() : null;
        // Legacy fallback: if province is blank but city is present, fallback province to city
        if ((province == null || province.isBlank()) && (city != null && !city.isBlank())) {
            province = city;
        }
        LocalDate dateOfBirth = profile != null ? profile.getDateOfBirth() : null;

        boolean avatarPresent = profile != null && profile.getAvatarStorageKey() != null && !profile.getAvatarStorageKey().isBlank();
        Instant avatarUpdatedAt = profile != null ? profile.getAvatarUpdatedAt() : null;

        Instant accountCreatedAt = null;
        if (user.getCreatedAt() != null) {
            accountCreatedAt = user.getCreatedAt().atZone(ZoneId.systemDefault()).toInstant();
        }

        List<String> authMethods = new ArrayList<>();
        boolean hasCredentials = user.getPassword() != null && !"NONE".equalsIgnoreCase(user.getCredentialStatus());
        if (hasCredentials) {
            authMethods.add("CREDENTIALS");
        }
        if (authIdentityRepository.existsByUserIdAndProvider(user.getId(), "GOOGLE")) {
            authMethods.add("GOOGLE");
        }
        if (authMethods.isEmpty() && user.getPassword() != null) {
            authMethods.add("CREDENTIALS");
        }

        boolean canChangePassword = hasCredentials;

        String heatmapTheme = (profile != null && profile.getHeatmapTheme() != null && !profile.getHeatmapTheme().isBlank())
                ? profile.getHeatmapTheme().toLowerCase()
                : "purple";

        return new UserProfileDto(
                user.getEmail(),
                user.getName(),
                effectiveDisplayName,
                phone,
                city,
                province,
                dateOfBirth,
                accountCreatedAt,
                avatarPresent,
                avatarUpdatedAt,
                authMethods,
                canChangePassword,
                heatmapTheme
        );
    }

    private static final java.util.Set<String> ALLOWED_HEATMAP_THEMES = java.util.Set.of(
            "GREEN", "BLUE", "PURPLE", "ORANGE", "PINK", "CYAN"
    );

    @Transactional
    public UserProfileDto updateHeatmapTheme(Long userId, String theme) {
        if (userId == null) {
            throw new IllegalArgumentException("User ID is required");
        }
        if (theme == null || theme.isBlank()) {
            throw new IllegalArgumentException("Heatmap theme is required");
        }
        String normalized = theme.trim().toUpperCase();
        if (!ALLOWED_HEATMAP_THEMES.contains(normalized)) {
            throw new IllegalArgumentException("Invalid heatmap theme. Allowed: " + ALLOWED_HEATMAP_THEMES);
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        UserProfile profile = userProfileRepository.findById(userId).orElse(null);
        if (profile == null) {
            profile = UserProfile.builder()
                    .userId(userId)
                    .heatmapTheme(normalized.toLowerCase())
                    .build();
        } else {
            profile.setHeatmapTheme(normalized.toLowerCase());
        }

        profile = userProfileRepository.save(profile);
        log.info("Updated heatmap theme to {} for user {}", normalized.toLowerCase(), userId);

        return buildProfileDto(user, profile);
    }

    private boolean containsControlCharacters(String s) {
        if (s == null) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isISOControl(c) || c < 32) {
                return true;
            }
        }
        return false;
    }
}
