package com.innorder.occ.system

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import java.sql.Connection
import java.time.Duration
import javax.sql.DataSource

class DataSourceDatabaseProbeTest {
    @Test
    fun `validates within two seconds and closes the connection`() {
        val dataSource = mock(DataSource::class.java)
        val connection = mock(Connection::class.java)
        `when`(dataSource.connection).thenReturn(connection)
        `when`(connection.isValid(2)).thenReturn(true)

        DataSourceDatabaseProbe(dataSource, Duration.ofSeconds(2)).use { probe ->
            assertThat(probe.check()).isEqualTo(DatabaseProbeResult.ready())
        }

        verify(connection).isValid(2)
        verify(connection).close()
    }


    @Test
    fun `connection acquisition timeout returns sanitized result within total budget`() {
        val dataSource = mock(DataSource::class.java)
        `when`(dataSource.connection).thenAnswer {
            Thread.sleep(500)
            throw java.sql.SQLException("jdbc:postgresql://secret-host/internal")
        }

        val startedAt = System.nanoTime()
        val result = DataSourceDatabaseProbe(dataSource, Duration.ofMillis(50)).use { probe ->
            probe.check()
        }
        val elapsed = Duration.ofNanos(System.nanoTime() - startedAt)

        assertThat(elapsed).isLessThan(Duration.ofMillis(300))
        assertThat(result).isEqualTo(DatabaseProbeResult.unreachable("Database connection timed out"))
        assertThat(result.detail).doesNotContain("secret-host").doesNotContain("SQLException")
    }
}
