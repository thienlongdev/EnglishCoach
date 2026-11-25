package com.englishcoach.echocoach.repository;

import com.englishcoach.echocoach.entity.EchoCoachMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;

@Repository
public interface EchoCoachMessageRepository extends JpaRepository<EchoCoachMessage, Long> {

    List<EchoCoachMessage> findBySessionIdOrderByCreatedAtAsc(Long sessionId);

    @Modifying
    @Query("DELETE FROM EchoCoachMessage m WHERE m.sessionId = :sessionId")
    void deleteBySessionId(@Param("sessionId") Long sessionId);

    @Modifying
    @Query("DELETE FROM EchoCoachMessage m WHERE m.sessionId IN :sessionIds")
    void deleteBySessionIdIn(@Param("sessionIds") Collection<Long> sessionIds);

    long countBySessionId(Long sessionId);
}
