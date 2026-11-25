package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthIdentity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface AuthIdentityRepository extends JpaRepository<AuthIdentity, UUID> {
    Optional<AuthIdentity> findByProviderAndProviderSubject(String provider, String providerSubject);
    Optional<AuthIdentity> findByUserIdAndProvider(Long userId, String provider);
    boolean existsByProviderAndProviderSubject(String provider, String providerSubject);
    boolean existsByUserIdAndProvider(Long userId, String provider);
}
