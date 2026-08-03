package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.yaml.snakeyaml.Yaml
import kotlin.reflect.KClass
import kotlin.reflect.full.declaredMemberFunctions
import kotlin.reflect.full.memberProperties
import kotlin.reflect.jvm.javaMethod

class EvidenceControllerContractParityTest {
    @Test
    fun `controller exposes every committed evidence OpenAPI path`() {
        assertRoute("requirements", GetMapping::class, "/requirements")
        assertRoute("requirement", GetMapping::class, "/requirements/{requirementId}")
        assertRoute("createSession", PostMapping::class, "/upload-sessions")
        assertRoute("uploadStatus", GetMapping::class, "/upload-sessions/{uploadSessionId}")
        assertRoute("upload", PutMapping::class, "/upload-sessions/{uploadSessionId}/content")
        assertRoute("metadata", GetMapping::class, "/{evidenceId}")
        assertRoute("submit", PostMapping::class, "/{evidenceId}/submit")
        assertRoute("reviews", GetMapping::class, "/{evidenceId}/reviews")
        assertRoute("review", PostMapping::class, "/{evidenceId}/reviews")
        assertRoute("versions", GetMapping::class, "/{evidenceId}/versions")
        assertRoute("previewMetadata", GetMapping::class, "/{evidenceId}/preview")
        assertRoute("download", GetMapping::class, "/{evidenceId}/download")
        assertRoute("downloadMetadata", GetMapping::class, "/{evidenceId}/download-metadata")
    }

    @Test
    fun `command endpoints expose committed status and replay headers`() {
        listOf("createSession", "upload", "submit", "review").forEach { name ->
            val function = EvidenceController::class.declaredMemberFunctions.single { candidate ->
                candidate.name == name && candidate.javaMethod?.annotations?.any {
                    it is PostMapping || it is PutMapping
                } == true
            }
            val headers = function.parameters.flatMap { parameter ->
                parameter.annotations.filterIsInstance<RequestHeader>().map { it.name.ifBlank { it.value } }
            }
            assertThat(headers).contains("Idempotency-Key", "Expected-Version", "X-Correlation-ID")
        }
    }

    @Test
    fun `command response uses exact committed replay header`() {
        val method = EvidenceController::class.java.declaredMethods.single { it.name == "response" }
        assertThat(method.toString()).contains("ResponseEntity")
        val source = java.nio.file.Files.readString(java.nio.file.Path.of(
            "src/main/kotlin/com/innorder/occ/evidence/EvidenceController.kt",
        ))
        assertThat(source).contains("Idempotency-Replayed")
        assertThat(source).doesNotContain("X-Idempotent-Replay")
    }

    @Test
    fun `public DTO property names exactly match committed schemas`() {
        assertProperties(CreateEvidenceSessionRequest::class,
            "requirementId", "targetEntityId", "evidenceId", "slotKey", "extension", "expectedSha256", "expectedSizeBytes")
        assertProperties(EvidenceSession::class,
            "id", "evidenceId", "status", "expectedSha256", "expectedSizeBytes", "actualSha256", "actualSizeBytes",
            "detectedMediaType", "failureCode", "createdAt", "expiresAt", "version")
        assertProperties(SubmitEvidenceRequest::class, "evidenceVersion")
        assertProperties(EvidenceReviewRequest::class, "evidenceVersion", "decision", "reason", "conditions")
        assertProperties(EvidenceMetadata::class,
            "id", "requirementId", "targetEntityId", "slotKey", "state", "currentVersion", "version", "createdAt", "updatedAt")
        assertProperties(EvidenceVersion::class,
            "id", "evidenceId", "version", "uploadSessionId", "sha256", "mediaType", "extension", "sizeBytes", "submittedAt")
        assertProperties(EvidenceReview::class,
            "id", "evidenceId", "evidenceVersion", "decision", "reason", "conditions", "followUpDueAt", "gateSatisfied", "reviewedAt")
        assertProperties(EvidencePreviewMetadata::class,
            "evidenceId", "evidenceVersion", "mediaType", "sizeBytes", "generatedAt")
        assertProperties(EvidenceDownloadMetadata::class,
            "evidenceId", "evidenceVersion", "filename", "mediaType", "sizeBytes", "sha256", "disposition")
    }

    @Test
    fun `runtime evidence paths and DTOs have direct OpenAPI parity`() {
        val openApi = java.nio.file.Files.newInputStream(java.nio.file.Path.of(
            "../../packages/contracts/openapi/occ-core.yaml",
        )).use { Yaml().load<Map<String, Any>>(it) }
        @Suppress("UNCHECKED_CAST")
        val paths = openApi["paths"] as Map<String, Any>
        assertThat(paths.keys.filter { it.startsWith("/api/v1/evidence") }).containsExactlyInAnyOrder(
            "/api/v1/evidence/requirements", "/api/v1/evidence/requirements/{requirementId}",
            "/api/v1/evidence/upload-sessions", "/api/v1/evidence/upload-sessions/{uploadSessionId}",
            "/api/v1/evidence/upload-sessions/{uploadSessionId}/content", "/api/v1/evidence/{evidenceId}",
            "/api/v1/evidence/{evidenceId}/submit", "/api/v1/evidence/{evidenceId}/reviews",
            "/api/v1/evidence/{evidenceId}/versions", "/api/v1/evidence/{evidenceId}/preview",
            "/api/v1/evidence/{evidenceId}/download", "/api/v1/evidence/{evidenceId}/download-metadata",
        )
        @Suppress("UNCHECKED_CAST")
        val schemas = ((openApi["components"] as Map<String, Any>)["schemas"] as Map<String, Map<String, Any>>)
        listOf(
            "CreateEvidenceUploadSessionRequest" to CreateEvidenceSessionRequest::class,
            "EvidenceUploadSession" to EvidenceSession::class,
            "EvidenceMetadata" to EvidenceMetadata::class,
            "EvidenceVersion" to EvidenceVersion::class,
            "EvidenceReview" to EvidenceReview::class,
            "EvidencePreviewMetadata" to EvidencePreviewMetadata::class,
            "EvidenceDownloadMetadata" to EvidenceDownloadMetadata::class,
        ).forEach { (schemaName, runtimeType) ->
            @Suppress("UNCHECKED_CAST")
            val properties = schemas.getValue(schemaName)["properties"] as Map<String, Any>
            assertThat(runtimeType.memberProperties.map { it.name })
                .containsExactlyInAnyOrderElementsOf(properties.keys)
        }
    }

    @Test
    fun `range parser implements committed closed open and suffix forms`() {
        assertThat(EvidenceHttpSupport.range("bytes=2-5", 10)).isEqualTo(ObjectRange(2, 4))
        assertThat(EvidenceHttpSupport.range("bytes=7-", 10)).isEqualTo(ObjectRange(7, 3))
        assertThat(EvidenceHttpSupport.range("bytes=-3", 10)).isEqualTo(ObjectRange(7, 3))
    }

    @Test
    fun `requirement parser accepts only committed strict policy schema`() {
        val policy = EvidenceRequirementPolicy.parse(MAPPER.readTree(POLICY))
        assertThat(policy.minimumCount).isEqualTo(2)
        assertThat(policy.hardGate).isTrue()
        assertThat(policy.conditionalAdvancement).isFalse()
        assertThat(policy.conditionalFollowUpHours).isEqualTo(48)
        assertThat(policy.content.maximumBytes).isEqualTo(1024)
        assertThat(EvidenceRequirementPolicy.parse(MAPPER.readTree(POLICY.replace("10.0", "1.0")))
            .content.archiveLimits.maximumCompressionRatio).isEqualTo(1.0)
        assertThatThrownBy {
            EvidenceRequirementPolicy.parse(MAPPER.readTree(POLICY.replace("10.0", "0.5")))
        }.isInstanceOf(InvalidEvidenceRequirementException::class.java)
        assertThatThrownBy {
            EvidenceRequirementPolicy.parse(MAPPER.readTree(POLICY.replace("txt", ".TXT")))
        }.isInstanceOf(InvalidEvidenceRequirementException::class.java)
    }

    private fun assertRoute(name: String, annotation: KClass<out Annotation>, path: String) {
        val function = EvidenceController::class.declaredMemberFunctions.single { candidate ->
            candidate.name == name && candidate.javaMethod?.getAnnotation(annotation.java) != null
        }
        val mapping = function.javaMethod!!.getAnnotation(annotation.java)
        val values = when (mapping) {
            is GetMapping -> mapping.value.toList()
            is PostMapping -> mapping.value.toList()
            is PutMapping -> mapping.value.toList()
            else -> emptyList()
        }
        assertThat(values).containsExactly(path)
        function.parameters.filter { it.annotations.any { candidate -> candidate is PathVariable } }
            .forEach { assertThat(it.name).isNotBlank() }
    }

    private fun assertProperties(type: KClass<*>, vararg expected: String) {
        assertThat(type.memberProperties.map { it.name }.sorted()).containsExactlyElementsOf(expected.sorted())
    }

    private companion object {
        val MAPPER = ObjectMapper().findAndRegisterModules()
        const val POLICY = """{
          "allowedExtensions":["txt"],"allowedMediaTypes":["text/plain"],"maximumBytes":1024,
          "minimumCount":2,"hardGate":true,"conditionalAdvancement":false,"conditionalFollowUpHours":48,
          "archive":{"maximumEntries":10,"maximumExpandedBytes":2048,"maximumCompressionRatio":10.0}
        }"""
    }
}
