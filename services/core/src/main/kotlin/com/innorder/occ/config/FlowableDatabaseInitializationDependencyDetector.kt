package com.innorder.occ.config

import org.flowable.common.engine.api.Engine
import org.springframework.boot.sql.init.dependency.AbstractBeansOfTypeDependsOnDatabaseInitializationDetector
import org.springframework.core.env.Environment

class FlowableDatabaseInitializationDependencyDetector(
    private val environment: Environment,
) : AbstractBeansOfTypeDependsOnDatabaseInitializationDetector() {
    override fun getDependsOnDatabaseInitializationBeanTypes(): Set<Class<*>> =
        if (environment.getProperty(DETECTION_PROPERTY, Boolean::class.java, true)) {
            setOf(Engine::class.java)
        } else {
            emptySet()
        }

    private companion object {
        const val DETECTION_PROPERTY = "flowable.depends-on-database-initialization-detection"
    }
}
