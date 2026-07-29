package com.innorder.occ.config

import org.assertj.core.api.Assertions.assertThat
import org.flowable.common.engine.api.Engine
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.beans.factory.support.DefaultListableBeanFactory
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitializationDetector
import org.springframework.core.env.Environment
import org.springframework.core.io.support.SpringFactoriesLoader
import org.springframework.core.io.support.SpringFactoriesLoader.ArgumentResolver
import org.springframework.mock.env.MockEnvironment

class FlowableDatabaseInitializationDependencyDetectorTest {
    @Test
    fun `detects Flowable engines as database initialization dependents`() {
        val beanFactory = DefaultListableBeanFactory().apply {
            registerSingleton("processEngine", mock(Engine::class.java))
        }

        val detector = FlowableDatabaseInitializationDependencyDetector(MockEnvironment())

        assertThat(detector.detect(beanFactory)).containsExactly("processEngine")
    }

    @Test
    fun `supports disabling dependency detection`() {
        val beanFactory = DefaultListableBeanFactory().apply {
            registerSingleton("processEngine", mock(Engine::class.java))
        }
        val environment = MockEnvironment()
            .withProperty("flowable.depends-on-database-initialization-detection", "false")

        val detector = FlowableDatabaseInitializationDependencyDetector(environment)

        assertThat(detector.detect(beanFactory)).isEmpty()
    }

    @Test
    fun `registers detector through Spring factories`() {
        val detectors = SpringFactoriesLoader.forDefaultResourceLocation(javaClass.classLoader).load(
            DependsOnDatabaseInitializationDetector::class.java,
            ArgumentResolver.of(Environment::class.java, MockEnvironment()),
        )

        assertThat(detectors).anyMatch { it is FlowableDatabaseInitializationDependencyDetector }
    }
}
