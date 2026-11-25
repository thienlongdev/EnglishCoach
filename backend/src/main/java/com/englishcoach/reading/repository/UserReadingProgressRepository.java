package com.englishcoach.reading.repository;

import com.englishcoach.reading.entity.UserReadingProgress;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface UserReadingProgressRepository extends JpaRepository<UserReadingProgress, Long> {

    @Query("SELECT COUNT(DISTINCT r.readingMaterial.id) FROM UserReadingProgress r WHERE r.user.id = :userId AND r.scrollPercentage >= 80")
    long countCompletedMaterialsByUserId(@Param("userId") Long userId);
}
