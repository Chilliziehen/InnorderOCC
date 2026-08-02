package com.innorder.occ

import com.innorder.occ.iam.BootstrapIds
import org.springframework.boot.ApplicationRunner
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.jdbc.core.JdbcTemplate

@TestConfiguration(proxyBeanMethods = false)
class PlatformCatalogPrerequisiteTestConfiguration {
    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE + 1)
    fun platformCatalogPrerequisiteTestRunner(jdbc: JdbcTemplate) = ApplicationRunner {
        jdbc.update(
            """INSERT INTO catalog.domain_package(id, package_key, name, status)
               VALUES (?, 'platform-iam', 'Platform IAM', 'ACTIVE') ON CONFLICT DO NOTHING""",
            BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.package_version(id, package_id, semver, status)
               VALUES (?, ?, '1.0.0', 'DRAFT') ON CONFLICT DO NOTHING""",
            BootstrapIds.PACKAGE_VERSION, BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type(id, package_id, type_key, name, entity_kind, authorizable)
               VALUES (?, ?, 'platform.user', 'User', 'PRINCIPAL', true) ON CONFLICT DO NOTHING""",
            BootstrapIds.USER_TYPE, BootstrapIds.PACKAGE,
        )
        jdbc.update(
            """INSERT INTO catalog.entity_type_version
               (id, entity_type_id, package_version_id, schema_version, json_schema)
               VALUES (?, ?, ?, 1, '{}'::jsonb) ON CONFLICT DO NOTHING""",
            BootstrapIds.USER_TYPE_VERSION, BootstrapIds.USER_TYPE, BootstrapIds.PACKAGE_VERSION,
        )
        jdbc.update(
            """UPDATE catalog.package_version SET status = 'PUBLISHED', content_hash = repeat('a', 64),
                   published_at = transaction_timestamp() WHERE id = ? AND status = 'DRAFT'""",
            BootstrapIds.PACKAGE_VERSION,
        )
    }
}
