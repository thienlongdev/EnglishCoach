FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn clean package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
# --no-install-recommends: the helpers are pure Python, so no compiler toolchain (gcc, make, kernel headers) is
# shipped; pebble (the base image's unused service manager, a Go binary) is removed too (security closure 2026-10).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*  && rm -f /usr/bin/pebble
RUN pip3 install --no-cache-dir youtube-transcript-api yt-dlp --break-system-packages || true
COPY --from=build /app/target/*.jar app.jar
COPY --from=build /app/src/main/resources/lexical/dictionary_en_vi.db /app/data/dictionary_en_vi.db
COPY scripts /app/scripts
COPY asr_worker /app/asr_worker

# The application runs as an unprivileged user (uid 10001). It owns only what it writes: the storage directory (a
# volume in production; docker-entrypoint.sh hands an existing volume over) and the directory of the read-only
# dictionary database (SQLite keeps its shared-memory file beside the database). The JAR, the scripts and the rest
# of /app stay root-owned and are not writable by the application.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home --shell /usr/sbin/nologin app \
 && mkdir -p /app/storage \
 && chown -R app:app /app/storage /app/data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENV HOME=/home/app

EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["java", "-jar", "app.jar"]
