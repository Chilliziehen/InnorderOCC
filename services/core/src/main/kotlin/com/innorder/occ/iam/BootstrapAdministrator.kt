package com.innorder.occ.iam

import com.innorder.occ.auth.PasswordService
import org.springframework.boot.ApplicationArguments
import org.springframework.boot.ApplicationRunner
import org.springframework.boot.autoconfigure.condition.ConditionOutcome
import org.springframework.boot.autoconfigure.condition.SpringBootCondition
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.ConditionContext
import org.springframework.context.annotation.Conditional
import org.springframework.context.annotation.Configuration
import org.springframework.core.Ordered
import org.springframework.core.type.AnnotatedTypeMetadata
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.util.StringUtils
import java.nio.file.Path
import java.time.OffsetDateTime
import java.util.Locale
import java.util.UUID

@ConfigurationProperties(prefix = "occ.bootstrap-administrator", ignoreUnknownFields = false)
data class BootstrapAdministratorProperties(
    var passwordFile: String = "",
    var username: String = "admin",
    var displayName: String = "Platform Administrator",
    var deleteSecret: Boolean = false,
    var secretOwner: String = System.getProperty("user.name"),
)

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(BootstrapAdministratorProperties::class)
class BootstrapAdministratorConfiguration {
    @Bean
    internal fun bootstrapSecretReader(): BootstrapSecretReader = BootstrapSecretReader()

    @Bean
    @Conditional(BootstrapAdministratorConfiguredCondition::class)
    internal fun bootstrapAdministrator(
        jdbc: JdbcTemplate,
        authTransactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
        secretReader: BootstrapSecretReader,
        baseline: PlatformSecurityBaseline,
    ): BootstrapAdministrator = BootstrapAdministrator(
        jdbc, authTransactions, passwords, properties, secretReader, baseline,
    )
}

internal class BootstrapAdministratorConfiguredCondition : SpringBootCondition() {
    override fun getMatchOutcome(context: ConditionContext, metadata: AnnotatedTypeMetadata): ConditionOutcome {
        val configured = StringUtils.hasText(context.environment.getProperty("occ.bootstrap-administrator.password-file"))
        return if (configured) {
            ConditionOutcome.match("administrator password file is configured")
        } else {
            ConditionOutcome.noMatch("administrator password file is not configured")
        }
    }
}

class BootstrapConfigurationException : IllegalStateException("Administrator bootstrap configuration is invalid")
class BootstrapBaselineException : IllegalStateException("Administrator bootstrap baseline conflicts with existing data")
class BootstrapExecutionException : IllegalStateException("Administrator bootstrap failed")
class BootstrapSecretCleanupException : IllegalStateException(
    "Administrator bootstrap committed, but secret cleanup failed; remove the configured secret manually",
)

enum class BootstrapResult { CREATED, ALREADY_INITIALIZED }

internal object CanonicalUsername {
    private const val MAX_LENGTH = 128
    private val allowed = Regex("^[a-z0-9][a-z0-9._@-]*${'$'}")

    fun normalize(raw: String): String? {
        val normalized = raw.trim().lowercase(Locale.ROOT)
        return normalized.takeIf { it.length <= MAX_LENGTH && allowed.matches(it) }
    }
}

class BootstrapAdministrator internal constructor(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
    private val passwords: PasswordService,
    private val properties: BootstrapAdministratorProperties,
    private val secretReader: BootstrapSecretReader,
    private val baseline: PlatformSecurityBaseline,
) : ApplicationRunner, Ordered {
    override fun getOrder(): Int = ORDER

    internal constructor(
        jdbc: JdbcTemplate,
        transactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
        secretReader: BootstrapSecretReader,
    ) : this(
        jdbc, transactions, passwords, properties, secretReader,
        PlatformSecurityBaseline(jdbc, transactions),
    )

    constructor(
        jdbc: JdbcTemplate,
        transactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
    ) : this(
        jdbc, transactions, passwords, properties, BootstrapSecretReader(),
        PlatformSecurityBaseline(jdbc, transactions),
    )

    override fun run(args: ApplicationArguments) {
        bootstrap()
    }

    fun bootstrap(): BootstrapResult {
        val username = CanonicalUsername.normalize(properties.username) ?: throw BootstrapConfigurationException()
        val displayName = normalizeDisplayName(properties.displayName)
        val secretOwner = normalizeSecretOwner(properties.secretOwner)
        if (!StringUtils.hasText(properties.passwordFile)) throw BootstrapConfigurationException()
        baseline.ensure()
        var openedMaterial: BootstrapSecretMaterial? = null
        val outcome = try {
            transactions.execute {
                jdbc.queryForObject(
                    "SELECT pg_advisory_xact_lock(?) IS NULL",
                    Boolean::class.java,
                    PlatformSecurityBaseline.ADVISORY_LOCK,
                )
                val initialized = jdbc.queryForObject(
                    """SELECT EXISTS (SELECT 1 FROM iam.principal WHERE principal_kind = 'USER')
                              OR EXISTS (SELECT 1 FROM iam.user_account)""",
                    Boolean::class.java,
                ) == true
                if (initialized) return@execute BootstrapOutcome(BootstrapResult.ALREADY_INITIALIZED, null)

                val path = try {
                    Path.of(properties.passwordFile)
                } catch (_: Exception) {
                    throw BootstrapConfigurationException()
                }
                val material = secretReader.open(path, secretOwner)
                openedMaterial = material
                val hash = passwords.encode(material.characters)
                val now = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)!!
                jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
                val userId = UUID.randomUUID()
                jdbc.update(
                    """INSERT INTO authz.entity
                       (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                    userId, BootstrapIds.USER_TYPE, BootstrapIds.USER_TYPE_VERSION, "user:$username", now, now,
                )
                jdbc.update(
                    """INSERT INTO iam.principal
                       (id, principal_kind, display_name, status, created_at, updated_at)
                       VALUES (?, 'USER', ?, 'ACTIVE', ?, ?)""",
                    userId, displayName, now, now,
                )
                jdbc.update(
                    """INSERT INTO iam.user_account(principal_id, username, password_hash, password_version)
                       VALUES (?, ?, ?, 0)""",
                    userId, username, hash,
                )
                jdbc.update(
                    """INSERT INTO authz.relationship
                       (id, relation_definition_id, subject_entity_id, object_entity_id, valid_from,
                        source_kind, source_ref, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'SYSTEM', 'initial-administrator', ?, ?)""",
                    UUID.randomUUID(), BootstrapIds.ROLE_ASSIGNMENT_RELATION, userId,
                    BootstrapIds.ADMINISTRATOR_ROLE, now, now, now,
                )
                BootstrapOutcome(BootstrapResult.CREATED, material)
            }
        } catch (failure: RuntimeException) {
            openedMaterial?.close()
            when (failure) {
                is BootstrapConfigurationException, is BootstrapBaselineException -> throw failure
                else -> throw BootstrapExecutionException()
            }
        } ?: throw BootstrapExecutionException()

        val material = outcome.secretMaterial
        if (material != null) {
            try {
                if (properties.deleteSecret) material.delete()
            } finally {
                material.close()
            }
        }
        return outcome.result
    }

    private fun normalizeDisplayName(raw: String): String {
        val normalized = raw.trim()
        var codePoints = 0
        var offset = 0
        while (offset < normalized.length) {
            val current = normalized[offset]
            offset += when {
                Character.isHighSurrogate(current) -> {
                    if (offset + 1 >= normalized.length || !Character.isLowSurrogate(normalized[offset + 1])) {
                        throw BootstrapConfigurationException()
                    }
                    2
                }
                Character.isLowSurrogate(current) -> throw BootstrapConfigurationException()
                else -> 1
            }
            if (++codePoints > 256) throw BootstrapConfigurationException()
        }
        if (codePoints == 0) throw BootstrapConfigurationException()
        return normalized
    }

    private fun normalizeSecretOwner(raw: String): String {
        val owner = raw.trim()
        if (owner.isEmpty() || owner.codePointCount(0, owner.length) > 256 ||
            owner.any { it == '\u0000' || Character.isISOControl(it) }
        ) throw BootstrapConfigurationException()
        return owner
    }

    private data class BootstrapOutcome(val result: BootstrapResult, val secretMaterial: BootstrapSecretMaterial?)

    companion object {
        const val ORDER = 10
    }
}
