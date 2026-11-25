package com.englishcoach.common.cache;

import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.cache.support.SimpleValueWrapper;
import org.springframework.lang.Nullable;

import java.time.Duration;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.function.LongSupplier;

/**
 * Spring {@link CacheManager} backed by per-cache {@link BoundedTtlCache} instances with explicit hard bounds,
 * real TTL expiration, negative-value caching, and single-flight loading — with zero external dependencies.
 */
public class BoundedTtlCacheManager implements CacheManager {

    private static final Object NULL_KEY_SENTINEL = new Object();
    private static final long DEFAULT_NEGATIVE_TTL_MS = Duration.ofSeconds(30).toMillis();

    public record CacheSpec(int maxEntries, long ttlMillis, long negativeTtlMillis) {
        public CacheSpec {
            if (maxEntries < 1) throw new IllegalArgumentException("maxEntries must be >= 1");
            if (ttlMillis < 1) throw new IllegalArgumentException("ttlMillis must be >= 1");
            if (negativeTtlMillis < 0) throw new IllegalArgumentException("negativeTtlMillis must be >= 0");
        }

        public static CacheSpec of(int maxEntries, Duration ttl) {
            long ttlMs = Objects.requireNonNull(ttl, "ttl").toMillis();
            return new CacheSpec(maxEntries, ttlMs, Math.min(DEFAULT_NEGATIVE_TTL_MS, ttlMs));
        }

        public static CacheSpec of(int maxEntries, Duration ttl, Duration negativeTtl) {
            return new CacheSpec(
                    maxEntries,
                    Objects.requireNonNull(ttl, "ttl").toMillis(),
                    Objects.requireNonNull(negativeTtl, "negativeTtl").toMillis()
            );
        }
    }

    private final Map<String, Cache> caches;
    private final Collection<String> cacheNames;

    public BoundedTtlCacheManager(Map<String, CacheSpec> specs) {
        this(specs, System::currentTimeMillis);
    }

    public BoundedTtlCacheManager(Map<String, CacheSpec> specs, LongSupplier clock) {
        Objects.requireNonNull(specs, "specs");
        Objects.requireNonNull(clock, "clock");
        Map<String, Cache> map = new LinkedHashMap<>();
        for (Map.Entry<String, CacheSpec> entry : specs.entrySet()) {
            String name = Objects.requireNonNull(entry.getKey(), "cache name");
            CacheSpec spec = Objects.requireNonNull(entry.getValue(), "cache spec for " + name);
            BoundedTtlCache<Object, Object> nativeCache = new BoundedTtlCache<>(
                    spec.maxEntries(),
                    spec.ttlMillis(),
                    spec.negativeTtlMillis(),
                    clock
            );
            map.put(name, new BoundedTtlSpringCache(name, nativeCache, spec.negativeTtlMillis() > 0L));
        }
        this.caches = Collections.unmodifiableMap(map);
        this.cacheNames = Collections.unmodifiableSet(this.caches.keySet());
    }

    @Override
    @Nullable
    public Cache getCache(String name) {
        return caches.get(name);
    }

    @Override
    public Collection<String> getCacheNames() {
        return cacheNames;
    }

    private static final class LoaderFailure extends RuntimeException {
        private final Throwable original;

        LoaderFailure(Throwable original) {
            super(null, original, false, false);
            this.original = original;
        }
    }

    private static final class BoundedTtlSpringCache implements Cache {
        private final String name;
        private final BoundedTtlCache<Object, Object> delegate;
        private final boolean allowNullValues;

        private BoundedTtlSpringCache(String name, BoundedTtlCache<Object, Object> delegate, boolean allowNullValues) {
            this.name = name;
            this.delegate = delegate;
            this.allowNullValues = allowNullValues;
        }

        private static Object normalizeKey(@Nullable Object key) {
            return key != null ? key : NULL_KEY_SENTINEL;
        }

        @Override
        public String getName() {
            return name;
        }

        @Override
        public Object getNativeCache() {
            return delegate;
        }

        @Override
        @Nullable
        public ValueWrapper get(Object key) {
            BoundedTtlCache.Lookup<Object> lookup = delegate.lookupIfPresent(normalizeKey(key));
            return lookup.hit() ? new SimpleValueWrapper(lookup.value()) : null;
        }

        @Override
        @SuppressWarnings("unchecked")
        @Nullable
        public <T> T get(Object key, @Nullable Class<T> type) {
            BoundedTtlCache.Lookup<Object> lookup = delegate.lookupIfPresent(normalizeKey(key));
            if (!lookup.hit()) {
                return null;
            }
            Object value = lookup.value();
            if (value != null && type != null && !type.isInstance(value)) {
                throw new IllegalStateException(
                        "Cached value is not of required type [" + type.getName() + "]: " + value);
            }
            return (T) value;
        }

        @Override
        @SuppressWarnings("unchecked")
        @Nullable
        public <T> T get(Object key, Callable<T> valueLoader) {
            Object k = normalizeKey(key);
            try {
                if (allowNullValues) {
                    return (T) delegate.getOrNull(k, ignored -> invokeLoader(valueLoader));
                }
                return (T) delegate.get(k, ignored -> invokeLoader(valueLoader));
            } catch (LoaderFailure failure) {
                throw new ValueRetrievalException(key, valueLoader, failure.original);
            }
        }

        private static <T> T invokeLoader(Callable<T> valueLoader) {
            try {
                return valueLoader.call();
            } catch (Throwable ex) {
                throw new LoaderFailure(ex);
            }
        }

        @Override
        public void put(Object key, @Nullable Object value) {
            delegate.putNullable(normalizeKey(key), value, allowNullValues);
        }

        @Override
        @Nullable
        public ValueWrapper putIfAbsent(Object key, @Nullable Object value) {
            BoundedTtlCache.Lookup<Object> existing = delegate.putIfAbsent(normalizeKey(key), value, allowNullValues);
            return existing.hit() ? new SimpleValueWrapper(existing.value()) : null;
        }

        @Override
        public void evict(Object key) {
            delegate.invalidate(normalizeKey(key));
        }

        @Override
        public boolean evictIfPresent(Object key) {
            return delegate.evictIfPresent(normalizeKey(key));
        }

        @Override
        public void clear() {
            delegate.clear();
        }

        @Override
        public boolean invalidate() {
            return delegate.clearIfNotEmpty();
        }
    }
}
