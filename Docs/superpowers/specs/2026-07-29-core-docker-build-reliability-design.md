# Core Docker Build Reliability Design

## Goal

Keep the Core image reproducible from a clean machine while allowing interrupted
Gradle downloads to be reused by later Docker build attempts.

## Context

The Core Docker build uses the repository's Gradle wrapper from a digest-pinned
Temurin JDK image. A cold build downloads the Gradle distribution and Maven
dependencies in one Docker `RUN`. Repeated DNS, routing, and TLS failures caused
that step to restart without retaining successfully verified artifacts.

The failures are environmental and fail safely. In particular, DNS returned
incorrect addresses for Docker Hub during investigation, so the build must not
work around certificate validation or introduce a newly resolved builder image.

## Design

Keep the existing digest-pinned Temurin build and runtime images, Gradle wrapper,
and `bootJar` command. Mount a BuildKit cache at `/root/.gradle` for the build
step with `sharing=locked` so wrapper distributions, dependency artifacts, and
verification state survive a failed build and can be reused safely.

Resolve Gradle plugins from Maven Central first and use the official Gradle
Plugin Portal only as a fallback for markers not published to Central. This
keeps Foojay resolution working while avoiding unnecessary proxying of Kotlin,
Spring, and other Maven-published artifacts through the Plugin Portal.

The cache is an optimization, not an input required for correctness. A clean
machine can still build using only the pinned base images and trusted Gradle and
Maven endpoints. Gradle dependency verification remains strict, and network or
integrity failures continue to stop the build.

## Security Boundaries

- Do not disable TLS validation or dependency verification.
- Do not pin transient DNS answers or add repository mirrors.
- Use only Maven Central and the official Gradle Plugin Portal.
- Do not copy host-built JARs or host Gradle caches into the image.
- Do not add a new builder image while its digest cannot be safely verified.
- Keep the cache confined to the build stage; no cache content enters runtime.

## Verification

The Dockerfile contract test must require the exact locked cache mount on the
Core `bootJar` step. Verification consists of:

1. Observing the contract fail before the mount is present.
2. Running `npm run test:infra` with real OPA and observing zero failures/skips.
3. Building the Core image from Compose until the complete build succeeds.
4. Running `npm run verify:full` after the Dockerfile change.
5. Running `git diff --check` and reviewing all changed and untracked files.

External DNS or TLS failures are reported as environmental blockers; they are
never converted into insecure fallback behavior.
