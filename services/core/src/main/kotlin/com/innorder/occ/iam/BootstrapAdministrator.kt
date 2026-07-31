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
import org.springframework.core.type.AnnotatedTypeMetadata
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.util.StringUtils
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermission
import java.time.Instant
import java.time.OffsetDateTime
import java.util.Locale
import java.util.UUID

@ConfigurationProperties(prefix = "occ.bootstrap-administrator", ignoreUnknownFields = false)
data class BootstrapAdministratorProperties(
    var passwordFile: String = "",
    var username: String = "admin",
    var displayName: String = "Platform Administrator",
    var deleteSecret: Boolean = false,
)

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(BootstrapAdministratorProperties::class)
class BootstrapAdministratorConfiguration {
    @Bean
    @Conditional(BootstrapAdministratorConfiguredCondition::class)
    fun bootstrapAdministrator(
        jdbc: JdbcTemplate,
        authTransactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
    ): BootstrapAdministrator = BootstrapAdministrator(jdbc, authTransactions, passwords, properties)
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

object BootstrapIds {
    // Reserved UUIDv7-shaped platform identities. These values are deployment-independent contracts.
    val PACKAGE: UUID = uuid("00000000-0000-7000-8000-000000000010")
    val PACKAGE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000011")
    val USER_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000012")
    val USER_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000013")
    val ROLE_TYPE: UUID = uuid("00000000-0000-7000-8000-000000000014")
    val ROLE_TYPE_VERSION: UUID = uuid("00000000-0000-7000-8000-000000000015")
    val ROLE_ASSIGNMENT_RELATION: UUID = uuid("00000000-0000-7000-8000-000000000002")
    val VIEWER_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000020")
    val OPERATOR_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000021")
    val ADMINISTRATOR_ROLE: UUID = uuid("00000000-0000-7000-8000-000000000022")

    private fun uuid(value: String): UUID = UUID.fromString(value)
}

internal object CanonicalUsername {
    private const val MAX_LENGTH = 128
    private val allowed = Regex("^[a-z0-9][a-z0-9._@-]*${'$'}")

    fun normalize(raw: String): String? {
        val normalized = raw.trim().lowercase(Locale.ROOT)
        return normalized.takeIf { it.length <= MAX_LENGTH && allowed.matches(it) }
    }
}

class SecretCharacters internal constructor(private val value: CharArray) : CharSequence {
    override val length: Int get() = value.size
    override fun get(index: Int): Char = value[index]
    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence = value.concatToString(startIndex, endIndex)
    override fun toString(): String = value.concatToString()
    fun clearSecret() = value.fill('\u0000')
}

internal data class BootstrapSecret(
    val characters: SecretCharacters,
    val identity: SecretFileIdentity,
)

internal enum class SecretFileKind { REGULAR, SYMLINK, REPARSE, DIRECTORY }

internal data class SecretFileMetadata(
    val kind: SecretFileKind,
    val size: Long,
    val fileKey: Any?,
    val creationTime: Instant,
    val modifiedTime: Instant,
    val posixPermissions: Set<PosixFilePermission>?,
)

internal interface SecretFileMetadataAccess {
    fun inspect(path: Path): SecretFileMetadata
    fun read(path: Path, maximumBytes: Int): ByteArray
    fun delete(path: Path)
}

internal data class SecretFileIdentity(
    val path: Path,
    val fileKey: Any?,
    val size: Long,
    val creation: Instant,
    val modified: Instant,
)

internal class BootstrapSecretFile(
    private val files: SecretFileMetadataAccess = NioSecretFileMetadataAccess,
) {
    fun read(path: Path): SecretCharacters = readValidated(path).characters

    internal fun readValidated(path: Path): BootstrapSecret {
        val before = inspectForRead(path)
        validateReadable(before)
        val bytes = try {
            files.read(path, MAX_BYTES)
        } catch (_: BootstrapConfigurationException) {
            throw invalid()
        } catch (_: Exception) {
            throw invalid()
        }
        try {
            val after = inspectForRead(path)
            validateReadable(after)
            if (((before.fileKey != null || after.fileKey != null) && before.fileKey != after.fileKey) ||
                before.size != after.size || before.creationTime != after.creationTime ||
                before.modifiedTime != after.modifiedTime
            ) invalid()
            val contentLength = when {
                bytes.size >= 2 && bytes[bytes.lastIndex - 1] == '\r'.code.toByte() && bytes.last() == '\n'.code.toByte() -> bytes.size - 2
                bytes.isNotEmpty() && bytes.last() == '\n'.code.toByte() -> bytes.size - 1
                else -> bytes.size
            }
            val decoded = try {
                StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, 0, contentLength))
            } catch (_: Exception) {
                throw invalid()
            }
            val chars = CharArray(decoded.remaining())
            decoded.get(chars)
            decoded.clear()
            while (decoded.hasRemaining()) decoded.put('\u0000')
            val secret = SecretCharacters(chars)
            if (chars.any { it == '\u0000' } || !PasswordService().isAllowed(secret)) {
                secret.clearSecret()
                throw invalid()
            }
            return BootstrapSecret(secret, identity(path, after))
        } finally {
            bytes.fill(0)
        }
    }

    internal fun deleteValidated(identity: SecretFileIdentity) {
        try {
            val current = files.inspect(identity.path)
            validateReadable(current)
            if (identity.fileKey == null || current.fileKey == null || identity.fileKey != current.fileKey ||
                identity.size != current.size || identity.creation != current.creationTime ||
                identity.modified != current.modifiedTime
            ) throw BootstrapSecretCleanupException()
            files.delete(identity.path)
        } catch (_: BootstrapSecretCleanupException) {
            throw BootstrapSecretCleanupException()
        } catch (_: Exception) {
            throw BootstrapSecretCleanupException()
        }
    }

    private fun inspectForRead(path: Path): SecretFileMetadata = try {
        files.inspect(path)
    } catch (_: Exception) {
        throw invalid()
    }

    private fun validateReadable(metadata: SecretFileMetadata) {
        if (metadata.kind != SecretFileKind.REGULAR || metadata.size > MAX_BYTES) invalid()
        metadata.posixPermissions?.let { permissions ->
            val readOnly = setOf(PosixFilePermission.OWNER_READ)
            val readWrite = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
            if (permissions != readOnly && permissions != readWrite) invalid()
        }
    }

    private fun identity(path: Path, metadata: SecretFileMetadata) = SecretFileIdentity(
        path.toAbsolutePath().normalize(),
        metadata.fileKey,
        metadata.size,
        metadata.creationTime,
        metadata.modifiedTime,
    )

    private fun invalid(): Nothing = throw BootstrapConfigurationException()

    private companion object {
        const val MAX_BYTES = 1024
    }
}

internal object NioSecretFileMetadataAccess : SecretFileMetadataAccess {
    override fun inspect(path: Path): SecretFileMetadata {
        val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        val symbolicLink = Files.isSymbolicLink(path)
        val fileStore = if (!symbolicLink && attributes.isRegularFile) Files.getFileStore(path) else null
        val reparsePoint = if (fileStore?.supportsFileAttributeView("dos") == true) {
            val dosAttributes = Files.getAttribute(path, "dos:attributes", LinkOption.NOFOLLOW_LINKS) as Int
            dosAttributes and WINDOWS_REPARSE_POINT_ATTRIBUTE != 0
        } else {
            false
        }
        val kind = when {
            symbolicLink -> SecretFileKind.SYMLINK
            reparsePoint -> SecretFileKind.REPARSE
            attributes.isRegularFile -> SecretFileKind.REGULAR
            attributes.isDirectory -> SecretFileKind.DIRECTORY
            else -> SecretFileKind.REPARSE
        }
        val permissions = if (kind == SecretFileKind.REGULAR && fileStore?.supportsFileAttributeView("posix") == true) {
            Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS)
        } else {
            null
        }
        return SecretFileMetadata(
            kind,
            attributes.size(),
            attributes.fileKey(),
            attributes.creationTime().toInstant(),
            attributes.lastModifiedTime().toInstant(),
            permissions,
        )
    }

    override fun read(path: Path, maximumBytes: Int): ByteArray =
        Files.newByteChannel(path, setOf(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)).use { channel ->
            val buffer = ByteBuffer.allocate(maximumBytes + 1)
            while (buffer.hasRemaining() && channel.read(buffer) >= 0) Unit
            if (buffer.position() > maximumBytes || channel.read(ByteBuffer.allocate(1)) >= 0) {
                throw BootstrapConfigurationException()
            }
            buffer.flip()
            ByteArray(buffer.remaining()).also(buffer::get)
        }

    override fun delete(path: Path) = Files.delete(path)

    private const val WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400
}

class BootstrapAdministrator internal constructor(
    private val jdbc: JdbcTemplate,
    private val transactions: TransactionTemplate,
    private val passwords: PasswordService,
    private val properties: BootstrapAdministratorProperties,
    private val secretDeleter: (SecretFileIdentity) -> Unit,
) : ApplicationRunner {
    constructor(
        jdbc: JdbcTemplate,
        transactions: TransactionTemplate,
        passwords: PasswordService,
        properties: BootstrapAdministratorProperties,
    ) : this(jdbc, transactions, passwords, properties, BootstrapSecretFile()::deleteValidated)

    override fun run(args: ApplicationArguments) {
        bootstrap()
    }

    fun bootstrap(): BootstrapResult {
        val username = CanonicalUsername.normalize(properties.username) ?: throw BootstrapConfigurationException()
        val displayName = normalizeDisplayName(properties.displayName)
        if (!StringUtils.hasText(properties.passwordFile)) throw BootstrapConfigurationException()
        val outcome = try {
            transactions.execute {
                jdbc.queryForObject("SELECT pg_advisory_xact_lock(?) IS NULL", Boolean::class.java, BOOTSTRAP_LOCK)
                if (jdbc.queryForObject(
                        """SELECT EXISTS (SELECT 1 FROM iam.principal WHERE principal_kind = 'USER')
                                  OR EXISTS (SELECT 1 FROM iam.user_account)""",
                        Boolean::class.java,
                    ) == true
                ) {
                    return@execute BootstrapOutcome(BootstrapResult.ALREADY_INITIALIZED, null)
                }

                val path = try {
                    Path.of(properties.passwordFile)
                } catch (_: Exception) {
                    throw BootstrapConfigurationException()
                }
                val secret = BootstrapSecretFile().readValidated(path)
                try {
                    val hash = passwords.encode(secret.characters)
                    val now = jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)!!
                    seedCatalog(now)
                    jdbc.queryForObject("SELECT authz.lock_authorization_state_for_change()", Long::class.java)
                    seedRoles(now)
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
                    BootstrapOutcome(BootstrapResult.CREATED, secret.identity)
                } finally {
                    secret.characters.clearSecret()
                }
            }
        } catch (failure: RuntimeException) {
            when (failure) {
                is BootstrapConfigurationException, is BootstrapBaselineException -> throw failure
                else -> throw BootstrapExecutionException()
            }
        } ?: throw BootstrapExecutionException()

        if (outcome.result == BootstrapResult.CREATED && properties.deleteSecret) {
            secretDeleter(requireNotNull(outcome.secretIdentity))
        }
        return outcome.result
    }

    private fun seedCatalog(now: OffsetDateTime) {
        ensure(
            "catalog.domain_package", "id = ? OR package_key = ?",
            arrayOf(BootstrapIds.PACKAGE, PACKAGE_KEY),
            """id = ? AND package_key = ? AND name = ? AND description = ? AND status = 'ACTIVE'
               AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL""",
            arrayOf(BootstrapIds.PACKAGE, PACKAGE_KEY, "Platform IAM", "Immutable platform identity and role authorization baseline"),
        ) {
            jdbc.update(
                """INSERT INTO catalog.domain_package
                   (id, package_key, name, description, status, created_at, updated_at)
                   VALUES (?, ?, 'Platform IAM', 'Immutable platform identity and role authorization baseline', 'ACTIVE', ?, ?)""",
                BootstrapIds.PACKAGE, PACKAGE_KEY, now, now,
            )
        }
        ensurePackageVersion(now)
        ensureType(BootstrapIds.USER_TYPE, "platform.user", "User")
        ensureType(BootstrapIds.ROLE_TYPE, "platform.role", "Role")
        ensureTypeVersion(BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE)
        ensureTypeVersion(BootstrapIds.ROLE_TYPE_VERSION, BootstrapIds.ROLE_TYPE)
        ensureRelationDefinition()
        val status = jdbc.queryForObject(
            "SELECT status FROM catalog.package_version WHERE id = ?", String::class.java, BootstrapIds.PACKAGE_VERSION,
        )
        if (status != "PUBLISHED") {
            if (status != "DRAFT") throw BootstrapBaselineException()
            jdbc.update(
                """UPDATE catalog.package_version
                   SET status = 'PUBLISHED', content_hash = ?, published_at = ?
                   WHERE id = ?""",
                CONTENT_HASH, now, BootstrapIds.PACKAGE_VERSION,
            )
        }
        if (count(
                """SELECT count(*) FROM catalog.package_version
                   WHERE id = ? AND package_id = ? AND semver = '1.0.0' AND status = 'PUBLISHED'
                     AND manifest = '{"bootstrap":"platform-iam","version":1}'::jsonb AND content_hash = ?
                     AND published_at IS NOT NULL""",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE, CONTENT_HASH,
            ) != 1L
        ) throw BootstrapBaselineException()
    }

    private fun ensurePackageVersion(now: OffsetDateTime) {
        ensure(
            "catalog.package_version", "id = ? OR (package_id = ? AND semver = '1.0.0')",
            arrayOf(BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE),
            """id = ? AND package_id = ? AND semver = '1.0.0' AND status IN ('DRAFT', 'PUBLISHED')
               AND manifest = '{"bootstrap":"platform-iam","version":1}'::jsonb
               AND created_by IS NULL AND published_by IS NULL
               AND ((status = 'DRAFT' AND content_hash IS NULL AND published_at IS NULL)
                    OR (status = 'PUBLISHED' AND content_hash = ? AND published_at IS NOT NULL))""",
            arrayOf(BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE, CONTENT_HASH),
        ) {
            jdbc.update(
                """INSERT INTO catalog.package_version(id, package_id, semver, status, manifest, created_at)
                   VALUES (?, ?, '1.0.0', 'DRAFT', '{"bootstrap":"platform-iam","version":1}'::jsonb, ?)""",
                BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE, now,
            )
        }
    }

    private fun ensureType(id: UUID, key: String, name: String) {
        ensure(
            "catalog.entity_type", "id = ? OR (package_id = ? AND type_key = ?)", arrayOf(id, BootstrapIds.PACKAGE, key),
            "id = ? AND package_id = ? AND type_key = ? AND name = ? AND entity_kind = 'PRINCIPAL' AND authorizable",
            arrayOf(id, BootstrapIds.PACKAGE, key, name),
        ) {
            jdbc.update(
                """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
                   VALUES (?, ?, ?, ?, 'PRINCIPAL', true)""",
                id, BootstrapIds.PACKAGE, key, name,
            )
        }
    }

    private fun ensureTypeVersion(id: UUID, typeId: UUID) {
        ensure(
            "catalog.entity_type_version",
            "id = ? OR (entity_type_id = ? AND schema_version = 1) OR (entity_type_id = ? AND package_version_id = ?)",
            arrayOf(id, typeId, typeId, BootstrapIds.PACKAGE_VERSION),
            """id = ? AND entity_type_id = ? AND package_version_id = ? AND schema_version = 1
               AND json_schema = '{}'::jsonb AND ui_schema = '{}'::jsonb
               AND auth_schema = '{}'::jsonb AND index_spec = '{}'::jsonb""",
            arrayOf(id, typeId, BootstrapIds.PACKAGE_VERSION),
        ) {
            jdbc.update(
                """INSERT INTO catalog.entity_type_version
                   (id, entity_type_id, package_version_id, schema_version, json_schema)
                   VALUES (?, ?, ?, 1, '{}'::jsonb)""",
                id, typeId, BootstrapIds.PACKAGE_VERSION,
            )
        }
    }

    private fun ensureRelationDefinition() {
        ensure(
            "catalog.relation_definition",
            "id = ? OR (package_version_id = ? AND relation_key = 'platform.role-assignment')",
            arrayOf(BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION),
            """id = ? AND package_version_id = ? AND relation_key = 'platform.role-assignment'
               AND subject_type_id = ? AND object_type_id = ? AND cardinality = 'MANY_TO_MANY'
               AND NOT transitive AND NOT acyclic AND auth_relevant AND max_subjects IS NULL AND max_objects IS NULL""",
            arrayOf(
                BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            ),
        ) {
            jdbc.update(
                """INSERT INTO catalog.relation_definition
                   (id, package_version_id, relation_key, subject_type_id, object_type_id, cardinality,
                    transitive, acyclic, auth_relevant)
                   VALUES (?, ?, 'platform.role-assignment', ?, ?, 'MANY_TO_MANY', false, false, true)""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION, BootstrapIds.PACKAGE_VERSION,
                BootstrapIds.USER_TYPE, BootstrapIds.ROLE_TYPE,
            )
        }
    }

    private fun seedRoles(now: OffsetDateTime) {
        listOf(
            Triple(BootstrapIds.VIEWER_ROLE, "role:viewer", "Viewer"),
            Triple(BootstrapIds.OPERATOR_ROLE, "role:operator", "Operator"),
            Triple(BootstrapIds.ADMINISTRATOR_ROLE, "role:administrator", "Administrator"),
        ).forEach { (id, key, name) ->
            ensure(
                "authz.entity", "id = ? OR (entity_type_id = ? AND entity_key = ?)",
                arrayOf(id, BootstrapIds.ROLE_TYPE, key),
                """id = ? AND entity_type_id = ? AND entity_type_version_id = ? AND entity_key = ?
                   AND state = 'ACTIVE' AND auth_attributes = '{}'::jsonb AND row_version = 0
                   AND created_by IS NULL AND updated_by IS NULL""",
                arrayOf(id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, key),
            ) {
                jdbc.update(
                    """INSERT INTO authz.entity
                       (id, entity_type_id, entity_type_version_id, entity_key, state, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                    id, BootstrapIds.ROLE_TYPE, BootstrapIds.ROLE_TYPE_VERSION, key, now, now,
                )
            }
            ensure(
                "iam.principal", "id = ?", arrayOf(id),
                """id = ? AND principal_kind = 'ROLE' AND display_name = ? AND status = 'ACTIVE'
                   AND profile = '{}'::jsonb AND row_version = 0 AND created_by IS NULL AND updated_by IS NULL""",
                arrayOf(id, name),
            ) {
                jdbc.update(
                    """INSERT INTO iam.principal
                       (id, principal_kind, display_name, status, created_at, updated_at)
                       VALUES (?, 'ROLE', ?, 'ACTIVE', ?, ?)""",
                    id, name, now, now,
                )
            }
        }
    }

    private fun ensure(
        table: String,
        collisionPredicate: String,
        collisionArguments: Array<Any>,
        expectedPredicate: String,
        expectedArguments: Array<Any>,
        insert: () -> Unit,
    ) {
        val collisions = count("SELECT count(*) FROM $table WHERE $collisionPredicate", *collisionArguments)
        if (collisions == 0L) {
            try {
                insert()
            } catch (_: Exception) {
                throw BootstrapBaselineException()
            }
            return
        }
        if (collisions != 1L || count("SELECT count(*) FROM $table WHERE $expectedPredicate", *expectedArguments) != 1L) {
            throw BootstrapBaselineException()
        }
    }

    private fun count(sql: String, vararg arguments: Any): Long =
        jdbc.queryForObject(sql, Long::class.java, *arguments) ?: 0L

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

    private data class BootstrapOutcome(val result: BootstrapResult, val secretIdentity: SecretFileIdentity?)

    private companion object {
        const val BOOTSTRAP_LOCK = 0x4f4343424f4f5453L
        const val PACKAGE_KEY = "platform-iam"
        const val CONTENT_HASH = "ac6022b02682cc2c737269adb4320750e6d92c51727952392dd45a1b969dbd76"
    }
}
