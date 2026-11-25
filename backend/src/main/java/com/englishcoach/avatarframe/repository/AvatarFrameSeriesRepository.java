package com.englishcoach.avatarframe.repository;

import com.englishcoach.avatarframe.entity.AvatarFrameSeries;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface AvatarFrameSeriesRepository extends JpaRepository<AvatarFrameSeries, Long> {
    Optional<AvatarFrameSeries> findBySlug(String slug);
}
