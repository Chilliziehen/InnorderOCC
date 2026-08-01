package com.innorder.occ.evidence

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import java.net.URI
import java.time.Duration

@ConfigurationProperties(prefix = "occ.object-storage", ignoreUnknownFields = false)
class EvidenceStorageProperties(
    var endpoint: String = "http://localhost:9000",
    var bucket: String = "innorder-occ",
    var accessKey: String = "",
    var secretKey: String = "",
    var requestTimeout: Duration = Duration.ofSeconds(10),
) {
    fun validate(): EvidenceStorageProperties {
        val uri = try {
            URI(endpoint)
        } catch (_: Exception) {
            throw IllegalArgumentException("Invalid object storage configuration")
        }
        require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()) {
            "Invalid object storage configuration"
        }
        require(uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
            "Invalid object storage configuration"
        }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { "Invalid object storage configuration" }
        require(BUCKET_PATTERN.matches(bucket) && bucket.length in 3..63 && !bucket.contains("..")) {
            "Invalid object storage configuration"
        }
        require(accessKey.length in 3..64 && accessKey.none(Char::isWhitespace)) {
            "Invalid object storage configuration"
        }
        require(secretKey.length in 8..128 && secretKey.none(Char::isWhitespace)) {
            "Invalid object storage configuration"
        }
        require(requestTimeout > Duration.ZERO && requestTimeout <= Duration.ofSeconds(30)) {
            "Invalid object storage configuration"
        }
        return this
    }

    override fun toString(): String = "EvidenceStorageProperties(redacted)"

    private companion object {
        val BUCKET_PATTERN = Regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$")
    }
}

@Configuration(proxyBeanMethods = false)
@Profile("!test & !flowable-init")
@EnableConfigurationProperties(EvidenceStorageProperties::class)
class EvidenceStorageConfiguration {
    @Bean
    fun objectStore(properties: EvidenceStorageProperties): ObjectStore = MinioObjectStore(properties.validate())
}
