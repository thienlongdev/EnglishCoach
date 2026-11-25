package com.englishcoach.content.repository;

import com.englishcoach.content.entity.ListeningContent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.Optional;

@Repository
public interface ListeningContentRepository extends JpaRepository<ListeningContent, Long> {

    Optional<ListeningContent> findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc(String kind, LocalDate featuredOn);

    Optional<ListeningContent> findFirstByKindOrderByCreatedAtDescIdDesc(String kind);
}
