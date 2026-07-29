package com.innorder.occ.system

import jakarta.annotation.PreDestroy
import org.apache.kafka.clients.admin.Admin
import org.apache.kafka.clients.admin.AdminClientConfig
import org.flowable.engine.RepositoryService
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.annotation.Order
import org.springframework.data.redis.connection.RedisConnectionFactory
import org.springframework.stereotype.Component
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.TimeUnit

@Component
@Order(10)
class PostgresqlStatusProbe(private val databaseProbe: DatabaseProbe) : StatusProbe {
    override val id = "postgresql"
    override val label = "PostgreSQL"
    override val external = false

    override fun check(): ProbeStatus {
        val result = databaseProbe.check()
        return if (result.reachable) ProbeStatus.ready(id, label)
        else ProbeStatus.unreachable(id, label, "PostgreSQL unavailable")
    }
}

@Component
@Order(20)
class FlowableStatusProbe(private val repositoryService: RepositoryService) : StatusProbe {
    override val id = "flowable"
    override val label = "Flowable"
    override val external = true

    override fun check(): ProbeStatus {
        repositoryService.createDeploymentQuery().count()
        return ProbeStatus.ready(id, label)
    }
}

fun interface HttpHealthClient {
    fun get(uri: URI): Int
}

@Component
class JdkHttpHealthClient : HttpHealthClient {
    private val client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofMillis(1_500))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build()

    override fun get(uri: URI): Int {
        val request = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofMillis(1_500))
            .header("Accept", "application/json")
            .GET()
            .build()
        return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
    }
}

@Component
@Order(30)
class OpaStatusProbe(
    private val client: HttpHealthClient,
    @param:Value("\${occ.opa.base-url:http://localhost:8181}") private val baseUrl: URI,
) : StatusProbe {
    override val id = "opa"
    override val label = "OPA"
    override val external = true

    override fun check(): ProbeStatus {
        check(client.get(baseUrl.resolve("/health")) in 200..299)
        return ProbeStatus.ready(id, label)
    }
}

fun interface KafkaMetadataClient {
    fun clusterId(): String?
}

@Component
class AdminKafkaMetadataClient(
    @Value("\${spring.kafka.bootstrap-servers:localhost:9092}") bootstrapServers: String,
) : KafkaMetadataClient, AutoCloseable {
    private val admin = Admin.create(
        mapOf(
            AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG to bootstrapServers,
            AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG to 1_500,
            AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG to 1_500,
            AdminClientConfig.CLIENT_ID_CONFIG to "occ-status-probe",
        ),
    )

    override fun clusterId(): String? = admin.describeCluster().clusterId().get(1_500, TimeUnit.MILLISECONDS)

    @PreDestroy
    override fun close() {
        admin.close(Duration.ZERO)
    }
}

@Component
@Order(40)
class KafkaStatusProbe(private val metadata: KafkaMetadataClient) : StatusProbe {
    override val id = "kafka"
    override val label = "Kafka"
    override val external = true

    override fun check(): ProbeStatus {
        check(!metadata.clusterId().isNullOrBlank())
        return ProbeStatus.ready(id, label)
    }
}

@Component
@Order(50)
class RedisStatusProbe(private val connectionFactory: RedisConnectionFactory) : StatusProbe {
    override val id = "redis"
    override val label = "Redis"
    override val external = true

    override fun check(): ProbeStatus {
        val response = connectionFactory.connection.use { it.ping() }
        check(response == "PONG")
        return ProbeStatus.ready(id, label)
    }
}

@Component
@Order(60)
class MinioStatusProbe(
    private val client: HttpHealthClient,
    @param:Value("\${occ.object-storage.endpoint:http://localhost:9000}") private val baseUrl: URI,
) : StatusProbe {
    override val id = "minio"
    override val label = "MinIO"
    override val external = true

    override fun check(): ProbeStatus {
        check(client.get(baseUrl.resolve("/minio/health/ready")) in 200..299)
        return ProbeStatus.ready(id, label)
    }
}
