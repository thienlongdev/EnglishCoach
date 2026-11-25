package com.englishcoach.avatarframe.repository;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;

@Repository
public interface AvatarFrameRequirementRepository extends JpaRepository<AvatarFrameRequirement, Long> {
    List<AvatarFrameRequirement> findByFrameId(Long frameId);

    @Query("SELECT r FROM AvatarFrameRequirement r JOIN FETCH r.frame WHERE r.frame.id IN :frameIds")
    List<AvatarFrameRequirement> findByFrameIdIn(@Param("frameIds") Collection<Long> frameIds);
}
