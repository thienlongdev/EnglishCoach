package com.englishcoach.avatarframe.repository;

import com.englishcoach.avatarframe.entity.AvatarFrame;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface AvatarFrameRepository extends JpaRepository<AvatarFrame, Long> {

    Optional<AvatarFrame> findBySlug(String slug);

    @Query("SELECT f FROM AvatarFrame f JOIN FETCH f.series WHERE f.isActive = true ORDER BY f.id ASC")
    List<AvatarFrame> findAllActiveWithSeries();
}
