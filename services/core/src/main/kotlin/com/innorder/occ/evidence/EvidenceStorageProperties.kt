package com.innorder.occ.evidence

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.context.properties.source.ConfigurationPropertySources
import org.springframework.boot.env.ConfigTreePropertySource
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.env.ConfigurableEnvironment
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
        require(accessKey.length in 16..64 && accessKey.none(Char::isWhitespace)) {
            "Invalid object storage configuration"
        }
        require(secretKey.length in 32..128 && secretKey.none(Char::isWhitespace)) {
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
    fun objectStore(
        properties: EvidenceStorageProperties,
        environment: ConfigurableEnvironment,
    ): ObjectStore {
        requireConfigTreeProperty(environment, ACCESS_KEY_PROPERTY)
        requireConfigTreeProperty(environment, SECRET_KEY_PROPERTY)
        return MinioObjectStore(properties.validate())
    }

    private fun requireConfigTreeProperty(environment: ConfigurableEnvironment, name: String) {
        val source = environment.propertySources.firstOrNull {
            !ConfigurationPropertySources.isAttachedConfigurationPropertySource(it) && it.containsProperty(name)
        }
        require(source is ConfigTreePropertySource) { "Invalid object storage configuration" }
    }

    private companion object {
        const val ACCESS_KEY_PROPERTY = "occ.object-storage.access-key"
        const val SECRET_KEY_PROPERTY = "occ.object-storage.secret-key"
    }
}
