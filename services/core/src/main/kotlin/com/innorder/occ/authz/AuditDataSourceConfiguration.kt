package com.innorder.occ.authz

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.PlatformTransactionManager

interface AuditDatabase {
    val jdbc: JdbcTemplate
    val transactionManager: PlatformTransactionManager
}

class AuditDataSourceHandle(properties: DataSourceProperties) : AuditDatabase, AutoCloseable {
    val dataSource = HikariDataSource(HikariConfig().apply {
        poolName = "occ-audit"
        jdbcUrl = properties.determineUrl()
        username = properties.determineUsername()
        password = properties.determinePassword()
        driverClassName = properties.determineDriverClassName()
        maximumPoolSize = 2
        minimumIdle = 0
        connectionTimeout = 1_500
        validationTimeout = 1_000
        initializationFailTimeout = -1
        connectionInitSql = "SET statement_timeout = '1500ms'; SET lock_timeout = '500ms'"
    })
    override val jdbc = JdbcTemplate(dataSource).apply { queryTimeout = 2 }
    override val transactionManager = DataSourceTransactionManager(dataSource)

    override fun close() = dataSource.close()

    override fun toString(): String = "AuditDataSourceHandle(pool=occ-audit,maxPoolSize=2)"
}

@Configuration(proxyBeanMethods = false)
class AuditDataSourceConfiguration {
    @Bean(destroyMethod = "close")
    fun auditDataSourceHandle(properties: DataSourceProperties) = AuditDataSourceHandle(properties)
}
