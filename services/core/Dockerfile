FROM eclipse-temurin:21.0.8_9-jdk-jammy@sha256:adb9b2d15adf1833d9dae0bdc1cff61ef5a804dc58dfbfb34269f32432b2e5dc AS build

WORKDIR /workspace
COPY gradlew settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle ./gradle
COPY services/core ./services/core
COPY database/migrations ./database/migrations
RUN --mount=type=cache,target=/root/.gradle,sharing=locked sed -i 's/\r$//' gradlew \
    && chmod +x gradlew \
    && ./gradlew :services:core:bootJar --no-daemon \
    && find services/core/build/libs -maxdepth 1 -name 'core-*.jar' ! -name '*-plain.jar' -exec cp {} /workspace/app.jar \;

FROM eclipse-temurin:21.0.8_9-jre-jammy@sha256:db1689535962d757a5adabf57387584ed543d38c0b9d1fe870123ea362ad73b0 AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 innorder \
    && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /app innorder \
    && install -d -o 10001 -g 10001 -m 0700 /run/innorder-bootstrap
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/app.jar /app/app.jar
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD ["curl", "-fsS", "http://localhost:8080/actuator/health/readiness"]
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
