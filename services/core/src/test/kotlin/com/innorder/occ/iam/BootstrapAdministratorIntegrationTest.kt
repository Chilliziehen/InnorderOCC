package com.innorder.occ.iam

import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import com.innorder.occ.auth.AccessTokenService
import com.innorder.occ.auth.AuthService
import com.innorder.occ.auth.InvalidCredentialsException
import com.innorder.occ.auth.PasswordService
import com.innorder.occ.auth.SessionRepository
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito.mock
import org.mockito.Mockito.RETURNS_DEFAULTS
import org.mockito.Mockito.verifyNoInteractions
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.testcontainers.containers.PostgreSQLContainer
import org.testcontainers.utility.DockerImageName
import org.testcontainers.utility.MountableFile
import org.flywaydb.core.Flyway
import org.postgresql.ds.PGSimpleDataSource
import org.springframework.security.crypto.password.PasswordEncoder
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.security.SecureRandom
import java.time.Clock
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BootstrapAdministratorIntegrationTest {
    @TempDir
    lateinit var temp: Path

    @Test
    fun `secret reader accepts one newline and rejects weak malformed oversized and nul secrets`() {
        val valid = secret("bootstrap-password-value\r\n")
        val chars = BootstrapSecretFile().read(valid)
        try {
            assertThat(chars.toString()).isEqualTo("bootstrap-password-value")
        } finally {
            chars.clearSecret()
        }

        listOf(
            "short-value",
            "valid-password\u0000",
            "x".repeat(1025),
        ).forEachIndexed { index, value ->
            val path = secret(value, "invalid-$index")
            assertThatThrownBy { BootstrapSecretFile().read(path) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
                .hasMessage("Administrator bootstrap configuration is invalid")
        }

        val malformed = temp.resolve("malformed")
        Files.write(malformed, byteArrayOf(0xc3.toByte(), 0x28))
        ownerOnly(malformed)
        assertThatThrownBy { BootstrapSecretFile().read(malformed) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `real secret reader rejects directories`() {
        assertThatThrownBy { BootstrapSecretFile().read(temp) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `first bootstrap creates only an active administrator and bumps authorization once`() {
        database { jdbc, transactions ->
            val password = TEST_PASSWORD
            val path = secret(password)
            val before = jdbc.queryForObject(
                "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                Long::class.java,
            )!!
            val bootstrap = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(path.toString(), "  ADMIN  ", " Platform Administrator ", false),
            )

            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)

            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
            val account = jdbc.queryForMap(
                """SELECT ua.principal_id, ua.username, ua.password_hash, ua.password_version,
                          p.display_name, p.status, e.state
                   FROM iam.user_account ua
                   JOIN iam.principal p ON p.id = ua.principal_id
                   JOIN authz.entity e ON e.id = ua.principal_id""",
            )
            assertThat(account["username"]).isEqualTo("admin")
            assertThat(account["display_name"]).isEqualTo("Platform Administrator")
            assertThat(account["status"]).isEqualTo("ACTIVE")
            assertThat(account["state"]).isEqualTo("ACTIVE")
            assertThat(account["password_version"]).isEqualTo(0)
            assertThat((account["principal_id"] as UUID).version()).isEqualTo(4)
            val hash = account["password_hash"] as String
            assertThat(hash).startsWith("${'$'}argon2id${'$'}").doesNotContain(password)
            assertThat(PasswordService().matches(password, hash)).isTrue()
            assertThat(jdbc.queryForObject(
                "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                Long::class.java,
            )).isEqualTo(before + 1)
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM authz.relationship
                   WHERE relation_definition_id = ? AND object_entity_id = ? AND source_kind = 'SYSTEM'
                     AND source_ref = 'initial-administrator' AND revoked_at IS NULL""",
                Long::class.java,
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                BootstrapIds.ADMINISTRATOR_ROLE,
            )).isEqualTo(1)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
            assertThat(jdbc.queryForMap(
                """SELECT id, package_key, name, description, status
                   FROM catalog.domain_package WHERE id = ?""",
                BootstrapIds.PACKAGE,
            )).containsAllEntriesOf(mapOf(
                "id" to BootstrapIds.PACKAGE,
                "package_key" to "platform-iam",
                "name" to "Platform IAM",
                "description" to "Immutable platform identity and role authorization baseline",
                "status" to "ACTIVE",
            ))
            assertThat(jdbc.queryForMap(
                """SELECT id, package_version_id, relation_key, subject_type_id, object_type_id,
                          cardinality, transitive, acyclic, auth_relevant, max_subjects, max_objects
                   FROM catalog.relation_definition WHERE id = ?""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION,
            )).containsAllEntriesOf(mapOf(
                "id" to BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                "package_version_id" to BootstrapIds.PACKAGE_VERSION,
                "relation_key" to "platform.role-assignment",
                "subject_type_id" to BootstrapIds.USER_TYPE,
                "object_type_id" to BootstrapIds.ROLE_TYPE,
                "cardinality" to "MANY_TO_MANY",
                "transitive" to false,
                "acyclic" to false,
                "auth_relevant" to true,
                "max_subjects" to null,
                "max_objects" to null,
            ))
            assertThat(jdbc.queryForMap(
                """SELECT pv.id, pv.package_id, pv.semver, pv.status, pv.content_hash, dp.package_key,
                          pv.manifest = '{"bootstrap":"platform-iam","version":1}'::jsonb AS manifest_matches
                   FROM catalog.package_version pv
                   JOIN catalog.domain_package dp ON dp.id = pv.package_id
                   WHERE pv.id = ?""",
                BootstrapIds.PACKAGE_VERSION,
            )).containsAllEntriesOf(mapOf(
                "id" to BootstrapIds.PACKAGE_VERSION,
                "package_id" to BootstrapIds.PACKAGE,
                "semver" to "1.0.0",
                "status" to "PUBLISHED",
                "content_hash" to CONTENT_HASH,
                "package_key" to "platform-iam",
                "manifest_matches" to true,
            ))
            assertThat(jdbc.queryForObject(
                """SELECT count(*) FROM catalog.entity_type et
                   JOIN catalog.entity_type_version etv ON etv.entity_type_id = et.id
                   WHERE (et.id, etv.id, et.type_key, et.name, et.entity_kind, et.authorizable) IN
                     ((?, ?, 'platform.user', 'User', 'PRINCIPAL', true),
                      (?, ?, 'platform.role', 'Role', 'PRINCIPAL', true))
                     AND etv.package_version_id = ? AND etv.schema_version = 1
                     AND etv.json_schema = '{}'::jsonb AND etv.ui_schema = '{}'::jsonb
                     AND etv.auth_schema = '{}'::jsonb AND etv.index_spec = '{}'::jsonb""",
                Long::class.java,
                BootstrapIds.USER_TYPE,
                BootstrapIds.USER_TYPE_VERSION,
                BootstrapIds.ROLE_TYPE,
                BootstrapIds.ROLE_TYPE_VERSION,
                BootstrapIds.PACKAGE_VERSION,
            )).isEqualTo(2)
            assertThat(jdbc.queryForList(
                """SELECT e.id, e.entity_key, e.entity_type_id, e.entity_type_version_id, e.state,
                          p.display_name, p.status, p.principal_kind
                   FROM authz.entity e JOIN iam.principal p ON p.id = e.id
                   WHERE e.id IN (?, ?, ?) ORDER BY e.entity_key""",
                BootstrapIds.VIEWER_ROLE,
                BootstrapIds.OPERATOR_ROLE,
                BootstrapIds.ADMINISTRATOR_ROLE,
            )).containsExactly(
                roleRow(BootstrapIds.ADMINISTRATOR_ROLE, "role:administrator", "Administrator"),
                roleRow(BootstrapIds.OPERATOR_ROLE, "role:operator", "Operator"),
                roleRow(BootstrapIds.VIEWER_ROLE, "role:viewer", "Viewer"),
            )
            assertThat(jdbc.queryForMap(
                """SELECT r.relation_definition_id, r.subject_entity_id, r.object_entity_id,
                          r.attributes = '{}'::jsonb AS attributes_match, r.source_kind, r.source_ref,
                          r.valid_until, r.revoked_at, p.principal_kind AS subject_kind,
                          r.valid_from = r.created_at AND r.created_at = r.updated_at AS timestamps_match,
                          r.created_by IS NULL AND r.updated_by IS NULL AND r.revoked_by IS NULL AS actors_match,
                          r.row_version
                   FROM authz.relationship r
                   JOIN iam.principal p ON p.id = r.subject_entity_id""",
            )).containsAllEntriesOf(mapOf(
                "relation_definition_id" to BootstrapIds.ROLE_ASSIGNMENT_RELATION,
                "subject_entity_id" to account["principal_id"],
                "object_entity_id" to BootstrapIds.ADMINISTRATOR_ROLE,
                "attributes_match" to true,
                "source_kind" to "SYSTEM",
                "source_ref" to "initial-administrator",
                "valid_until" to null,
                "revoked_at" to null,
                "subject_kind" to "USER",
                "timestamps_match" to true,
                "actors_match" to true,
                "row_version" to 0L,
            ))
            assertThat(Files.exists(path)).isTrue()

            val principals = PrincipalRepository(jdbc)
            val sessions = SessionRepository(jdbc, transactions, Clock.systemUTC(), SecureRandom())
            val tokens = mock(AccessTokenService::class.java) { invocation ->
                when (invocation.method.name) {
                    "issue" -> "test-access-token"
                    "expiresInSeconds" -> 900L
                    else -> RETURNS_DEFAULTS.answer(invocation)
                }
            }
            val authentication = AuthService(
                principals, PasswordService(), sessions, tokens, transactions, Clock.systemUTC(),
            )
            assertThat(authentication.login(" ADMIN ", password).user.capabilities)
                .containsExactly("occ.admin", "occ.execute", "occ.read")
            assertThatThrownBy { authentication.login("admin", "wrong-test-only-password") }
                .isInstanceOf(InvalidCredentialsException::class.java)

            Files.delete(path)
            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(jdbc.queryForObject(
                "SELECT current_revision FROM authz.authorization_state WHERE singleton",
                Long::class.java,
            )).isEqualTo(before + 1)
        }
    }

    @Test
    fun `concurrent first bootstraps create one user and loser does not need its secret`() {
        database { jdbc, transactions ->
            val firstSecret = secret(TEST_PASSWORD, "first-secret")
            val secondSecret = secret("second-bootstrap-test-only-8g!R", "second-secret")
            val stableDeletionSupported = listOf(firstSecret, secondSecret).all {
                NioSecretFileMetadataAccess.inspect(it).fileKey != null
            }
            val first = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(firstSecret.toString(), deleteSecret = true),
            )
            val second = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(secondSecret.toString(), deleteSecret = true),
            )
            val start = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            try {
                val attempts = listOf(first, second).map { bootstrap ->
                    pool.submit<BootstrapResult> {
                        start.await()
                        bootstrap.bootstrap()
                    }
                }
                start.countDown()
                val results = attempts.map { runCatching { it.get(30, TimeUnit.SECONDS) } }
                val successes = results.mapNotNull { it.getOrNull() }
                if (stableDeletionSupported) {
                    assertThat(successes).containsExactlyInAnyOrder(
                        BootstrapResult.CREATED,
                        BootstrapResult.ALREADY_INITIALIZED,
                    )
                    assertThat(listOf(Files.exists(firstSecret), Files.exists(secondSecret)).count { it }).isEqualTo(1)
                } else {
                    assertThat(successes).containsExactly(BootstrapResult.ALREADY_INITIALIZED)
                    assertThat(results.single { it.isFailure }.exceptionOrNull())
                        .isInstanceOf(java.util.concurrent.ExecutionException::class.java)
                        .hasCauseInstanceOf(BootstrapSecretCleanupException::class.java)
                    assertThat(Files.exists(firstSecret)).isTrue()
                    assertThat(Files.exists(secondSecret)).isTrue()
                }
                assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
                assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
            } finally {
                start.countDown()
                pool.shutdownNow()
                assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
            }
        }
    }

    @Test
    fun `existing account and orphan USER principal both bypass a missing secret without writes`() {
        database { jdbc, transactions ->
            val initialSecret = secret(TEST_PASSWORD, "gate-initial-secret")
            val bootstrap = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(initialSecret.toString()),
            )
            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)
            Files.delete(initialSecret)
            val missing = temp.resolve("deliberately-missing-secret")
            val restart = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(missing.toString()),
            )

            val accountState = bootstrapState(jdbc)
            assertThat(restart.bootstrap()).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(bootstrapState(jdbc)).isEqualTo(accountState)

            jdbc.update("DELETE FROM iam.user_account")
            val orphanPrincipalState = bootstrapState(jdbc)
            assertThat(restart.bootstrap()).isEqualTo(BootstrapResult.ALREADY_INITIALIZED)
            assertThat(bootstrapState(jdbc)).isEqualTo(orphanPrincipalState)
            assertThat(Files.exists(missing)).isFalse()
        }
    }

    @Test
    fun `fixed ID conflict fails generically and rolls back all bootstrap writes`() {
        database { jdbc, transactions ->
            jdbc.update(
                "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'spoofed-platform', 'Spoofed', 'ACTIVE')",
                BootstrapIds.PACKAGE,
            )
            val path = secret(TEST_PASSWORD)
            val bootstrap = BootstrapAdministrator(
                jdbc, transactions, PasswordService(), BootstrapAdministratorProperties(path.toString()),
            )

            assertThatThrownBy { bootstrap.bootstrap() }
                .isInstanceOf(BootstrapBaselineException::class.java)
                .hasMessage("Administrator bootstrap baseline conflicts with existing data")
                .hasMessageNotContaining(TEST_PASSWORD)
                .hasMessageNotContaining(path.toString())
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isZero()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.entity", Long::class.java)).isZero()
            assertThat(Files.exists(path)).isTrue()
        }
    }

    @Test
    fun `delete secret happens after commit and refuses a replacement`() {
        database { jdbc, transactions ->
            val path = secret(TEST_PASSWORD)
            val bootstrap = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(path.toString(), deleteSecret = true),
            )
            if (NioSecretFileMetadataAccess.inspect(path).fileKey == null) {
                assertThatThrownBy { bootstrap.bootstrap() }
                    .isInstanceOf(BootstrapSecretCleanupException::class.java)
                assertThat(Files.exists(path)).isTrue()
            } else {
                assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)
                assertThat(Files.exists(path)).isFalse()
            }
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
        }

        val path = secret(TEST_PASSWORD, "replacement-race")
        val identity = BootstrapSecretFile().readValidated(path).also { it.characters.clearSecret() }.identity
        Files.delete(path)
        secret("different-test-only-secret", "replacement-race")
        assertThatThrownBy { BootstrapSecretFile().deleteValidated(identity) }
            .isInstanceOf(BootstrapSecretCleanupException::class.java)
            .hasMessageNotContaining(path.toString())
            .hasMessageNotContaining(TEST_PASSWORD)
        assertThat(Files.readString(path)).isEqualTo("different-test-only-secret")
    }

    @Test
    fun `replacement during post commit deletion fails while administrator remains committed`() {
        database { jdbc, transactions ->
            val path = secret(TEST_PASSWORD, "post-commit-race")
            val bootstrap = BootstrapAdministrator(
                jdbc,
                transactions,
                PasswordService(),
                BootstrapAdministratorProperties(path.toString(), deleteSecret = true),
            ) { identity ->
                Files.delete(path)
                secret("replacement-test-only-9h!S", "post-commit-race")
                BootstrapSecretFile().deleteValidated(identity)
            }

            assertThatThrownBy { bootstrap.bootstrap() }
                .isInstanceOf(BootstrapSecretCleanupException::class.java)
                .hasMessage("Administrator bootstrap committed, but secret cleanup failed; remove the configured secret manually")
                .hasMessageNotContaining(path.toString())
                .hasMessageNotContaining(TEST_PASSWORD)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
            assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
            assertThat(Files.readString(path)).isEqualTo("replacement-test-only-9h!S")
        }
    }

    @Test
    fun `invalid values and unknown properties fail before bootstrap work`() {
        val jdbc = mock(JdbcTemplate::class.java)
        val transactions = mock(TransactionTemplate::class.java)
        listOf(
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), "+invalid", "Administrator", false),
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), "admin", "", false),
            BootstrapAdministratorProperties(temp.resolve("unused").toString(), "admin", "x".repeat(257), false),
        ).forEach { properties ->
            assertThatThrownBy { BootstrapAdministrator(jdbc, transactions, PasswordService(), properties).bootstrap() }
                .isInstanceOf(BootstrapConfigurationException::class.java)
        }
        verifyNoInteractions(jdbc, transactions)

        ApplicationContextRunner()
            .withUserConfiguration(BootstrapAdministratorConfiguration::class.java)
            .withPropertyValues("occ.bootstrap-administrator.unexpected=true")
            .run { context ->
                assertThat(context.startupFailure).isNotNull()
            }

        ApplicationContextRunner()
            .withUserConfiguration(BootstrapAdministratorConfiguration::class.java)
            .withBean(JdbcTemplate::class.java, { mock(JdbcTemplate::class.java) })
            .withBean(TransactionTemplate::class.java, { mock(TransactionTemplate::class.java) })
            .withBean(PasswordService::class.java, { PasswordService() })
            .run { context ->
                assertThat(context).doesNotHaveBean(BootstrapAdministrator::class.java)
            }

        ApplicationContextRunner()
            .withUserConfiguration(BootstrapAdministratorConfiguration::class.java)
            .withBean(JdbcTemplate::class.java, { mock(JdbcTemplate::class.java) })
            .withBean(TransactionTemplate::class.java, { mock(TransactionTemplate::class.java) })
            .withBean(PasswordService::class.java, { PasswordService() })
            .withPropertyValues("occ.bootstrap-administrator.password-file=configured-secret")
            .run { context ->
                assertThat(context).hasSingleBean(BootstrapAdministrator::class.java)
                val properties = context.getBean(BootstrapAdministratorProperties::class.java)
                assertThat(properties.username).isEqualTo("admin")
                assertThat(properties.displayName).isEqualTo("Platform Administrator")
                assertThat(properties.deleteSecret).isFalse()
            }
    }

    @Test
    fun `bootstrap success and failures never log credentials hashes content or paths`() {
        val captured = mutableListOf<ILoggingEvent>()
        var encodedHash = ""
        val successPath = temp.resolve("success-log-secret")
        database { jdbc, transactions ->
            secret(LOG_PASSWORD, successPath.fileName.toString())
            captured += captureBootstrapLogs {
                BootstrapAdministrator(
                    jdbc,
                    transactions,
                    PasswordService(),
                    BootstrapAdministratorProperties(successPath.toString(), LOG_RAW_USERNAME, "Log Test Administrator"),
                ).bootstrap()
            }
            encodedHash = jdbc.queryForObject("SELECT password_hash FROM iam.user_account", String::class.java)!!
        }

        val failurePath = temp.resolve("failure-log-secret")
        database { jdbc, transactions ->
            jdbc.update(
                "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, 'log-conflict', 'Log Conflict', 'ACTIVE')",
                BootstrapIds.PACKAGE,
            )
            secret(LOG_FAILURE_CONTENT, failurePath.fileName.toString())
            val deterministicPasswords = PasswordService(object : PasswordEncoder {
                override fun encode(rawPassword: CharSequence): String = LOG_FAILURE_HASH
                override fun matches(rawPassword: CharSequence, encodedPassword: String): Boolean = false
            })
            captured += captureBootstrapLogs {
                assertThatThrownBy {
                    BootstrapAdministrator(
                        jdbc,
                        transactions,
                        deterministicPasswords,
                        BootstrapAdministratorProperties(failurePath.toString(), LOG_FAILURE_RAW_USERNAME, "Failure Administrator"),
                    ).bootstrap()
                }.isInstanceOf(BootstrapBaselineException::class.java)
                    .hasMessageNotContaining(LOG_FAILURE_CONTENT)
                    .hasMessageNotContaining(LOG_FAILURE_RAW_USERNAME)
                    .hasMessageNotContaining(LOG_FAILURE_NORMALIZED_USERNAME)
                    .hasMessageNotContaining(LOG_FAILURE_HASH)
                    .hasMessageNotContaining(failurePath.toAbsolutePath().toString())
            }
        }

        val rendered = captured.joinToString("\n") { event ->
            listOf(
                event.formattedMessage,
                event.argumentArray?.joinToString(" ").orEmpty(),
                event.throwableProxy?.message.orEmpty(),
            ).joinToString(" ")
        }
        listOf(
            LOG_PASSWORD,
            LOG_RAW_USERNAME,
            LOG_NORMALIZED_USERNAME,
            encodedHash,
            successPath.toAbsolutePath().toString(),
            LOG_FAILURE_CONTENT,
            LOG_FAILURE_RAW_USERNAME,
            LOG_FAILURE_NORMALIZED_USERNAME,
            LOG_FAILURE_HASH,
            failurePath.toAbsolutePath().toString(),
        ).forEach { forbidden -> assertThat(rendered).doesNotContain(forbidden) }
    }

    private fun secret(value: String, name: String = "admin-secret"): Path = temp.resolve(name).also {
        Files.writeString(it, value)
        ownerOnly(it)
    }

    private fun ownerOnly(path: Path) {
        if (Files.getFileStore(path).supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(path, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
        }
    }

    private fun migrate(postgres: PostgreSQLContainer<*>) {
        Flyway.configure()
            .dataSource(postgres.jdbcUrl, "innorder_flyway", "flyway-test-only")
            .locations("filesystem:../../database/migrations")
            .load()
            .migrate()
    }

    private fun database(block: (JdbcTemplate, TransactionTemplate) -> Unit) {
        PostgreSQLContainer(DockerImageName.parse(IMAGE).asCompatibleSubstituteFor("postgres")).use { postgres ->
            postgres.withDatabaseName("innorder_occ")
                .withUsername("innorder_admin")
                .withPassword("admin-test-only")
                .withCopyFileToContainer(
                    MountableFile.forClasspathResource("postgres-test-init.sql"),
                    "/docker-entrypoint-initdb.d/010-test-roles.sql",
                )
                .start()
            migrate(postgres)
            val dataSource = PGSimpleDataSource().apply {
                setURL(postgres.jdbcUrl)
                user = "innorder_runtime"
                password = "runtime-test-only"
            }
            block(JdbcTemplate(dataSource), TransactionTemplate(DataSourceTransactionManager(dataSource)))
        }
    }

    private fun bootstrapState(jdbc: JdbcTemplate): Map<String, Any> = jdbc.queryForMap(
        """SELECT
             (SELECT current_revision FROM authz.authorization_state WHERE singleton) AS revision,
             (SELECT count(*) FROM catalog.domain_package) AS packages,
             (SELECT count(*) FROM catalog.package_version) AS package_versions,
             (SELECT count(*) FROM catalog.entity_type) AS entity_types,
             (SELECT count(*) FROM catalog.entity_type_version) AS entity_type_versions,
             (SELECT count(*) FROM catalog.relation_definition) AS relation_definitions,
             (SELECT count(*) FROM authz.entity) AS entities,
             (SELECT coalesce(sum(row_version), 0) FROM authz.entity) AS entity_row_versions,
             (SELECT max(updated_at) FROM authz.entity) AS entity_updated_at,
             (SELECT count(*) FROM iam.principal) AS principals,
             (SELECT coalesce(sum(row_version), 0) FROM iam.principal) AS principal_row_versions,
             (SELECT max(updated_at) FROM iam.principal) AS principal_updated_at,
             (SELECT count(*) FROM iam.user_account) AS accounts,
             (SELECT count(*) FROM authz.relationship) AS relationships,
             (SELECT coalesce(sum(row_version), 0) FROM authz.relationship) AS relationship_row_versions,
             (SELECT max(updated_at) FROM authz.relationship) AS relationship_updated_at""",
    )

    private fun roleRow(id: UUID, key: String, displayName: String): Map<String, Any> = mapOf(
        "id" to id,
        "entity_key" to key,
        "entity_type_id" to BootstrapIds.ROLE_TYPE,
        "entity_type_version_id" to BootstrapIds.ROLE_TYPE_VERSION,
        "state" to "ACTIVE",
        "display_name" to displayName,
        "status" to "ACTIVE",
        "principal_kind" to "ROLE",
    )

    private fun captureBootstrapLogs(action: () -> Unit): List<ILoggingEvent> {
        val logger = org.slf4j.LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME) as Logger
        val appender = ListAppender<ILoggingEvent>().also {
            it.start()
            logger.addAppender(it)
        }
        return try {
            action()
            appender.list.toList()
        } finally {
            logger.detachAppender(appender)
            appender.stop()
        }
    }

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val TEST_PASSWORD = "bootstrap-test-only-7f!Q"
        private const val CONTENT_HASH = "ac6022b02682cc2c737269adb4320750e6d92c51727952392dd45a1b969dbd76"
        private const val LOG_PASSWORD = "log-success-test-only-4k!V"
        private const val LOG_RAW_USERNAME = " Log.Success@Test "
        private const val LOG_NORMALIZED_USERNAME = "log.success@test"
        private const val LOG_FAILURE_CONTENT = "log-failure-test-only-5m!W"
        private const val LOG_FAILURE_RAW_USERNAME = " Log.Failure@Test "
        private const val LOG_FAILURE_NORMALIZED_USERNAME = "log.failure@test"
        private const val LOG_FAILURE_HASH = "encoded-bootstrap-failure-hash-sensitive"
    }
}
