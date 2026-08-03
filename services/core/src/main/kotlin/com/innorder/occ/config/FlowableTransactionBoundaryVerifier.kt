package com.innorder.occ.config

import org.flowable.spring.SpringProcessEngineConfiguration
import org.flowable.spring.boot.EngineConfigurationConfigurer
import org.springframework.beans.factory.config.BeanPostProcessor
import org.springframework.core.env.Environment
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.jdbc.datasource.DelegatingDataSource
import org.springframework.stereotype.Component
import org.springframework.transaction.PlatformTransactionManager
import javax.sql.DataSource

@Component
@Order(Ordered.LOWEST_PRECEDENCE)
class FlowableTransactionBoundaryVerifier(
    private val applicationDataSource: DataSource,
    private val applicationTransactionManager: PlatformTransactionManager,
    private val environment: Environment,
) : BeanPostProcessor, EngineConfigurationConfigurer<SpringProcessEngineConfiguration> {
    override fun postProcessAfterInitialization(bean: Any, beanName: String): Any {
        if (bean is SpringProcessEngineConfiguration) {
            verify(applicationDataSource, applicationTransactionManager, bean, environment.activeProfiles.toSet())
        }
        return bean
    }

    override fun configure(engineConfiguration: SpringProcessEngineConfiguration) {
        verify(applicationDataSource, applicationTransactionManager, engineConfiguration, environment.activeProfiles.toSet())
    }

    companion object {
        private val SCHEMA_UPDATE_PROFILES = setOf("development", "test", "flowable-init")

        fun verify(
            applicationDataSource: DataSource,
            applicationTransactionManager: PlatformTransactionManager,
            flowable: SpringProcessEngineConfiguration,
            activeProfiles: Set<String>,
        ) {
            val sameDataSource = unwrap(applicationDataSource) === unwrap(flowable.dataSource)
            val sameTransactionManager = applicationTransactionManager === flowable.transactionManager
            val schemaUpdate = flowable.databaseSchemaUpdate?.lowercase()
            val schemaUpdateAllowed = schemaUpdate in setOf(null, "false", "none") ||
                activeProfiles.any(SCHEMA_UPDATE_PROFILES::contains)
            if (!sameDataSource || !sameTransactionManager || !schemaUpdateAllowed) {
                throw IllegalStateException("Flowable transaction boundary is invalid")
            }
        }

        private tailrec fun unwrap(dataSource: DataSource): DataSource =
            if (dataSource is DelegatingDataSource && dataSource.targetDataSource != null) {
                unwrap(dataSource.targetDataSource!!)
            } else {
                dataSource
            }
    }
}
