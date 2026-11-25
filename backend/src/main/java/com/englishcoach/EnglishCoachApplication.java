package com.englishcoach;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@EnableScheduling
@SpringBootApplication
public class EnglishCoachApplication {

    /**
     * HikariCP re-validates a pooled connection that has been idle for more than this many milliseconds before handing
     * it out; its own default is 500. A validation is one network round trip, and the production database is about
     * 90 ms away: at ordinary traffic nearly every borrow paid it (a request that borrows twenty times lost almost two
     * seconds — Phase 4 measurement). Phase 4 set ten seconds, which still charged every borrow of a quiet site (a
     * player whose garden refreshes every three minutes finds every connection older than that: three borrows, three
     * extra round trips per request). Since Phase 5 the pool itself checks every idle connection each 30 seconds
     * ({@code spring.datasource.hikari.keepalive-time}) and evicts a dead one, so a connection handed out without a
     * check has been proven alive at most half a minute earlier; the request path only re-checks one that sat unused
     * for five minutes. A JVM flag of the same name ({@code -Dcom.zaxxer.hikari.aliveBypassWindowMs=…}) still wins.
     */
    private static final String POOL_ALIVE_BYPASS = "com.zaxxer.hikari.aliveBypassWindowMs";

    public static void main(String[] args) {
        if (System.getProperty(POOL_ALIVE_BYPASS) == null) System.setProperty(POOL_ALIVE_BYPASS, "300000");
        SpringApplication.run(EnglishCoachApplication.class, args);
    }
}
