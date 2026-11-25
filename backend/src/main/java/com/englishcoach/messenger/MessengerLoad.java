package com.englishcoach.messenger;

import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;

/**
 * The Messenger shares one small server with learning. When someone is already waiting for a database connection, the courtesies (typing, presence, delivery marks) step
 * aside so messages, sign-in and lessons keep moving. Reading the pool's counter costs nothing.
 */
@Component
public class MessengerLoad {
    private final ObjectProvider<DataSource> source;
    private volatile HikariPoolMXBean pool;

    public MessengerLoad(ObjectProvider<DataSource> source) { this.source = source; }

    public boolean busy() {
        try {
            HikariPoolMXBean bean = pool;
            if (bean == null && source != null) {
                DataSource ds = source.getIfAvailable();
                if (ds != null && ds.isWrapperFor(HikariDataSource.class)) pool = bean = ds.unwrap(HikariDataSource.class).getHikariPoolMXBean();
            }
            return bean != null && bean.getThreadsAwaitingConnection() > 0;
        } catch (Exception e) {
            return false;
        }
    }
}
