package com.innorder.occ.authz

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties

class AuditDataSourceConfigurationTest {
    @Test
    fun `audit pool is bounded sanitized and closes cleanly`() {
        val password = "mutable-secret-password"
        val handle = AuditDataSourceHandle(DataSourceProperties().apply {
            url = "jdbc:h2:mem:audit-pool"
            username = "sa"
            this.password = password
            driverClassName = "org.h2.Driver"
        })

        assertThat(handle.dataSource.maximumPoolSize).isEqualTo(2)
        assertThat(handle.dataSource.minimumIdle).isZero()
        assertThat(handle.toString()).doesNotContain(password)

        handle.close()

        assertThat(handle.dataSource.isClosed).isTrue()
    }
}
