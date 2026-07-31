package com.innorder.occ.iam

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
        val chars = BootstrapSecretFile.read(valid)
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
            assertThatThrownBy { BootstrapSecretFile.read(path) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
                .hasMessage("Administrator bootstrap configuration is invalid")
        }

        val malformed = temp.resolve("malformed")
        Files.write(malformed, byteArrayOf(0xc3.toByte(), 0x28))
        ownerOnly(malformed)
        assertThatThrownBy { BootstrapSecretFile.read(malformed) }
            .isInstanceOf(BootstrapConfigurationException::class.java)
    }

    @Test
    fun `secret reader rejects symlinks and broad POSIX permissions when supported`() {
        val target = secret("bootstrap-password-value", "target")
        val link = temp.resolve("secret-link")
        runCatching { Files.createSymbolicLink(link, target.fileName) }.onSuccess {
            assertThatThrownBy { BootstrapSecretFile.read(link) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
        }

        if (Files.getFileStore(target).supportsFileAttributeView("posix")) {
            Files.setPosixFilePermissions(target, setOf(PosixFilePermission.OWNER_READ))
            BootstrapSecretFile.read(target).clearSecret()
            Files.setPosixFilePermissions(target, setOf(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.GROUP_READ,
            ))
            assertThatThrownBy { BootstrapSecretFile.read(target) }
                .isInstanceOf(BootstrapConfigurationException::class.java)
        }

        assertThatThrownBy { BootstrapSecretFile.read(temp) }
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
                """SELECT pv.id, pv.package_id, pv.semver, pv.status, pv.content_hash, dp.package_key
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
                "SELECT entity_key FROM authz.entity WHERE id IN (?, ?, ?) ORDER BY entity_key",
                String::class.java,
                BootstrapIds.VIEWER_ROLE,
                BootstrapIds.OPERATOR_ROLE,
                BootstrapIds.ADMINISTRATOR_ROLE,
            )).containsExactly("role:administrator", "role:operator", "role:viewer")
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
                assertThat(successes).containsExactlyInAnyOrder(
                    BootstrapResult.CREATED,
                    BootstrapResult.ALREADY_INITIALIZED,
                )
                assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
                assertThat(jdbc.queryForObject("SELECT count(*) FROM authz.relationship", Long::class.java)).isEqualTo(1)
                assertThat(listOf(Files.exists(firstSecret), Files.exists(secondSecret)).count { it }).isEqualTo(1)
            } finally {
                start.countDown()
                pool.shutdownNow()
                assertThat(pool.awaitTermination(15, TimeUnit.SECONDS)).isTrue()
            }
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
            assertThat(bootstrap.bootstrap()).isEqualTo(BootstrapResult.CREATED)
            assertThat(Files.exists(path)).isFalse()
            assertThat(jdbc.queryForObject("SELECT count(*) FROM iam.user_account", Long::class.java)).isEqualTo(1)
        }

        val path = secret(TEST_PASSWORD, "replacement-race")
        val identity = BootstrapSecretFile.readValidated(path).also { it.characters.clearSecret() }.identity
        Files.delete(path)
        secret("different-test-only-secret", "replacement-race")
        assertThatThrownBy { BootstrapSecretFile.deleteValidated(identity) }
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
                BootstrapSecretFile.deleteValidated(identity)
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

    companion object {
        private const val IMAGE = "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9"
        private const val TEST_PASSWORD = "bootstrap-test-only-7f!Q"
        private const val CONTENT_HASH = "ac6022b02682cc2c737269adb4320750e6d92c51727952392dd45a1b969dbd76"
    }
}
