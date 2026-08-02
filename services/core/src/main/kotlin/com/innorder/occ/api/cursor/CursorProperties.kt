package com.innorder.occ.api.cursor

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.boot.autoconfigure.condition.ConditionOutcome
import org.springframework.boot.autoconfigure.condition.SpringBootCondition
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.ConditionContext
import org.springframework.context.annotation.Conditional
import org.springframework.context.annotation.Configuration
import org.springframework.core.type.AnnotatedTypeMetadata
import org.springframework.util.StringUtils
import java.time.Clock

@ConfigurationProperties(prefix = "occ.cursor", ignoreUnknownFields = false)
data class CursorProperties(
    val currentKeyId: String = "current",
    val currentKeyFile: String = "",
    val previousKeyId: String? = null,
    val previousKeyFile: String? = null,
)

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(CursorProperties::class)
@Conditional(CursorConfiguredCondition::class)
class CursorConfiguration {
    @Bean
    fun cursorKeyRing(properties: CursorProperties): CursorKeyRing = CursorKeyRing.load(properties)

    @Bean
    fun cursorCodec(keyRing: CursorKeyRing, objectMapper: ObjectMapper, clock: Clock): CursorCodec =
        HmacCursorCodec(keyRing, objectMapper, clock)
}

internal class CursorConfiguredCondition : SpringBootCondition() {
    override fun getMatchOutcome(context: ConditionContext, metadata: AnnotatedTypeMetadata): ConditionOutcome =
        if (StringUtils.hasText(context.environment.getProperty("occ.cursor.current-key-file"))) {
            ConditionOutcome.match("cursor key file is configured")
        } else {
            ConditionOutcome.noMatch("cursor key file is not configured")
        }
}
