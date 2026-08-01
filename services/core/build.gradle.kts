import org.gradle.process.CommandLineArgumentProvider

plugins {
    id("org.springframework.boot")
    id("io.spring.dependency-management")
    kotlin("jvm")
    kotlin("plugin.spring")
}

group = rootProject.group
version = rootProject.version
extra["testcontainers.version"] = "1.21.4"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    implementation("org.apache.pdfbox:pdfbox:3.0.8") {
        exclude(group = "commons-logging", module = "commons-logging")
    }
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    implementation("org.springframework.kafka:spring-kafka")
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:flyway-database-postgresql")
    implementation("org.postgresql:postgresql")
    implementation("org.flowable:flowable-spring-boot-starter-process:7.1.0")
    implementation("io.minio:minio:8.5.17")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation(kotlin("reflect"))

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testImplementation("org.testcontainers:postgresql")
    testImplementation("org.testcontainers:kafka")
    testImplementation("org.testcontainers:junit-jupiter")
    testImplementation("org.testcontainers:toxiproxy")
    testRuntimeOnly("com.h2database:h2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.processResources {
    from(rootProject.layout.projectDirectory.dir("database/migrations")) {
        into("db/migration")
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    val strictDatabaseTests = providers.environmentVariable("INNORDER_STRICT_DATABASE_TESTS").orElse("0")
    val verifyDatabaseSelection = providers.environmentVariable("INNORDER_VERIFY_DATABASE_TEST_SELECTION").orElse("0")
    val requestedArguments = gradle.startParameter.taskRequests.flatMap { it.args }
    val requestedTestPatterns = buildList {
        requestedArguments.forEachIndexed { index, argument ->
            when {
                argument == "--tests" && index + 1 < requestedArguments.size -> add(requestedArguments[index + 1])
                argument.startsWith("--tests=") -> add(argument.substringAfter('='))
            }
        }
    }
    val evidenceDatabaseSelected = requestedTestPatterns.any {
        it.contains("EvidenceRiskResourcePostgreSqlIntegrationTest")
    }
    val evidenceDatabaseRequired = providers.provider {
        strictDatabaseTests.get() == "1" || evidenceDatabaseSelected
    }

    inputs.property("innorderStrictDatabaseTests", strictDatabaseTests)
    inputs.property("innorderVerifyDatabaseTestSelection", verifyDatabaseSelection)
    inputs.property("innorderEvidenceDatabaseSelected", evidenceDatabaseSelected)
    jvmArgumentProviders.add(CommandLineArgumentProvider {
        listOf("-Dinnorder.evidence-risk-resource-postgresql.required=${evidenceDatabaseRequired.get()}")
    })
    val fullEvidenceIntegration = providers.gradleProperty("fullEvidenceIntegration")
        .orElse(providers.systemProperty("innorder.fullIntegration"))
        .orElse("false")
    systemProperty("innorder.fullIntegration", fullEvidenceIntegration.get())
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21
        javaParameters = true
    }
}
