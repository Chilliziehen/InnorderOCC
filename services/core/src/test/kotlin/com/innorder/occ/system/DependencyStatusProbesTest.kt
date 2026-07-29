package com.innorder.occ.system

import org.assertj.core.api.Assertions.assertThat
import org.flowable.engine.RepositoryService
import org.flowable.engine.repository.DeploymentQuery
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import org.springframework.data.redis.connection.RedisConnection
import org.springframework.data.redis.connection.RedisConnectionFactory
import java.net.URI

class DependencyStatusProbesTest {
    @Test
    fun `Flowable probe performs only a repository count query`() {
        val repository = mock(RepositoryService::class.java)
        val query = mock(DeploymentQuery::class.java)
        `when`(repository.createDeploymentQuery()).thenReturn(query)
        `when`(query.count()).thenReturn(3)

        val result = FlowableStatusProbe(repository).check()

        assertThat(result).isEqualTo(ProbeStatus.ready("flowable", "Flowable"))
        verify(query).count()
    }

    @Test
    fun `OPA and MinIO probes use their fixed readiness paths`() {
        val requests = mutableListOf<URI>()
        val client = HttpHealthClient { uri ->
            requests += uri
            200
        }

        assertThat(OpaStatusProbe(client, URI("http://opa.internal:8181")).check())
            .isEqualTo(ProbeStatus.ready("opa", "OPA"))
        assertThat(MinioStatusProbe(client, URI("http://minio.internal:9000")).check())
            .isEqualTo(ProbeStatus.ready("minio", "MinIO"))
        assertThat(requests.map { it.path }).containsExactly("/health", "/minio/health/ready")
    }

    @Test
    fun `Kafka probe reads cluster metadata and Redis probe sends ping`() {
        val kafkaCalls = mutableListOf<String>()
        val redisFactory = mock(RedisConnectionFactory::class.java)
        val redis = mock(RedisConnection::class.java)
        `when`(redisFactory.connection).thenReturn(redis)
        `when`(redis.ping()).thenReturn("PONG")

        val kafka = KafkaStatusProbe(KafkaMetadataClient {
            kafkaCalls += "describeCluster"
            "occ-cluster"
        }).check()
        val redisResult = RedisStatusProbe(redisFactory).check()

        assertThat(kafka).isEqualTo(ProbeStatus.ready("kafka", "Kafka"))
        assertThat(kafkaCalls).containsExactly("describeCluster")
        assertThat(redisResult).isEqualTo(ProbeStatus.ready("redis", "Redis"))
        verify(redis).ping()
        verify(redis).close()
    }

    @Test
    fun `non-success HTTP and invalid protocol responses fail without exposing endpoints`() {
        val unavailable = HttpHealthClient { 503 }
        val redisFactory = mock(RedisConnectionFactory::class.java)
        val redis = mock(RedisConnection::class.java)
        `when`(redisFactory.connection).thenReturn(redis)
        `when`(redis.ping()).thenReturn("unexpected secret response")

        val probes = listOf(
            OpaStatusProbe(unavailable, URI("http://secret-opa:8181")),
            MinioStatusProbe(unavailable, URI("http://secret-minio:9000")),
            KafkaStatusProbe(KafkaMetadataClient { null }),
            RedisStatusProbe(redisFactory),
        )

        val results = ConcurrentStatusProbeRunner(probes, java.time.Duration.ofMillis(250), true).use { it.checkAll() }
        assertThat(results).allMatch { it.state == ServiceState.UNREACHABLE }
        assertThat(results.mapNotNull { it.detail }).noneMatch {
            it.contains("secret") || it.contains("503") || it.contains("unexpected")
        }
    }
}
