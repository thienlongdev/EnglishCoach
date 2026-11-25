package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
    Boolean existsByEmail(String email);

    Optional<User> findByEmailNormalized(String emailNormalized);
    Boolean existsByEmailNormalized(String emailNormalized);
    Optional<User> findFirstByRole(com.englishcoach.auth.entity.Role role);
}
