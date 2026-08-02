package com.innorder.occ.resource

import com.innorder.occ.api.CursorContext
import com.innorder.occ.api.CursorDirection
import com.innorder.occ.command.CanonicalJsonObject
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.OptimisticConflictException
import com.innorder.occ.events.OutboxRepository
import com.innorder.occ.iam.BootstrapIds
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.http.MediaType
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.test.web.servlet.post
import org.springframework.test.web.servlet.patch
import org.springframework.test.web.servlet.get
import org.springframework.transaction.support.TransactionTemplate
import java.time.OffsetDateTime
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ResourceServiceIntegrationTest : ResourceIntegrationSupport() {
    @Test
    fun `HTTP reservation conflict is generic and includes only resource and interval`() {
        val resource = createResource(capacity = 1)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 1)
        val token = loginToken()
        val request = ReserveResourceRequest(
            UUID.randomUUID(), requester, null, null, instant(9), instant(10), 1.toBigDecimal(), false,
        )

        val response = mockMvc.post("/api/v1/resources/${resource.id}/reservations") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "http-conflict-${UUID.randomUUID()}")
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(request)
        }.andExpect { status { isConflict() } }.andReturn().response.contentAsString

        assertThat(response).contains("OCC-RESERVATION-CONFLICT", resource.id.toString(), instant(9).toString(), instant(10).toString())
        assertThat(response).doesNotContain(requester.toString(), "reservationId", "requesterEntityId")
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ?",
            Long::class.java,
            request.id,
        )).isZero()
    }

    @Test
    fun `HTTP create preserves 201 and exact replay header`() {
        val id = entity("http-resource")
        val request = CreateResourceRequest(id, "ROOM", 2.toBigDecimal())
        val token = loginToken()
        val key = "http-create-${UUID.randomUUID()}"

        fun execute(replayed: Boolean) = mockMvc.post("/api/v1/resources") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", key)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(request)
        }.andExpect {
            status { isCreated() }
            header { string("X-Idempotent-Replay", replayed.toString()) }
        }.andReturn().response

        execute(false)
        execute(true)
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit.outbox_event WHERE aggregate_id = ? AND event_type = 'resource.created'",
            Long::class.java,
            id,
        )).isEqualTo(1)
    }

    @Test
    fun `managed resource availability inventory and schedule use canonical UTC cursors and per-row authorization`() {
        val resource = createResource()
        val requester = entity("requester")
        val availability = AddAvailabilityRequest(UUID.randomUUID(), instant(8), instant(18), AvailabilityMode.AVAILABLE, null)
        val updated = resources.addAvailability(
            resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(availability), availability,
        ).body
        val first = reserve(resource.id, requester, instant(9), instant(10), 3)
        val second = reserve(resource.id, requester, instant(10), instant(11), 4)

        assertThat(updated.version).isEqualTo(1)
        assertThat(resources.inventory(administratorId, UUID.randomUUID(), 100, null).items.map { it.id })
            .contains(resource.id)
        assertThat(resources.availability(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(12)))
            .extracting("mode").containsExactly(AvailabilityMode.AVAILABLE)

        val page1 = resources.schedule(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(12), 1, null)
        val page2 = resources.schedule(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(12), 1, page1.nextCursor)
        assertThat(page1.items.map { it.id }).containsExactly(first.id)
        assertThat(page2.items.map { it.id }).containsExactly(second.id)
        assertThat(page1.items.single().requesterEntityId).isNull()
        assertThat(page1.items.single().start.offset).isEqualTo(java.time.ZoneOffset.UTC)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?
               AND action_key = 'occ.reservation.identity.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )).isGreaterThanOrEqualTo(2)
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?
               AND action_key = 'occ.read' AND resource_entity_id = ? AND decision = 'ALLOW'""",
            Long::class.java,
            administratorId,
            resource.id,
        )).isGreaterThanOrEqualTo(2)
        val availabilityEvent = mapper.readTree(jdbc.queryForObject(
            "SELECT payload::text FROM audit.outbox_event WHERE aggregate_id = ? AND event_type = 'resource.availability-changed'",
            String::class.java,
            resource.id,
        ))
        assertThat(availabilityEvent.path("mode").textValue()).isEqualTo("AVAILABLE")
        assertThat(availabilityEvent.path("start").textValue()).isEqualTo(instant(8).toString())
        assertThat(availabilityEvent.path("end").textValue()).isEqualTo(instant(18).toString())
    }

    @Test
    fun `inventory scans denied database rows and does not return a false terminal page`() {
        val ids = (1..3).map { index -> UUID.fromString("10000000-0000-7000-8000-00000000000$index") }
        ids.forEach { id ->
            entity(id, "paged-resource")
            val request = CreateResourceRequest(id, "ROOM", 1.toBigDecimal())
            resources.create(metadata(), mapper.writeValueAsBytes(request), request)
        }
        jdbc.update("UPDATE authz.entity SET state = 'ARCHIVED' WHERE id IN (?, ?)", ids[0], ids[1])

        val page = resources.inventory(administratorId, UUID.randomUUID(), 1, null)

        assertThat(page.items.map { it.id }).containsExactly(ids[2])
    }

    @Test
    fun `inventory caps denied OPA calls and resumes after last examined row`() {
        val denied = (1..ResourceService.MAX_QUERY_AUTHORIZATION_CALLS).map(::pagedId)
        val allowed = pagedId(ResourceService.MAX_QUERY_AUTHORIZATION_CALLS + 1)
        (denied + allowed).forEach { id ->
            entity(id, "capped-resource")
            jdbc.update(
                "INSERT INTO occ.managed_resource(id, resource_type, capacity, state) VALUES (?, 'ROOM', 1, 'AVAILABLE')",
                id,
            )
        }
        jdbc.update(
            "UPDATE authz.entity SET state = 'ARCHIVED' WHERE id IN (${denied.joinToString(",") { "?" }})",
            *denied.toTypedArray(),
        )
        val initialCursor = inventoryCursor(pagedId(0), inclusive = false)
        val deniesBefore = jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?
               AND action_key = 'occ.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )!!

        val capped = resources.inventory(administratorId, UUID.randomUUID(), 1, initialCursor)

        assertThat(capped.items).isEmpty()
        assertThat(capped.nextCursor).isNotNull()
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?
               AND action_key = 'occ.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )).isEqualTo(deniesBefore + ResourceService.MAX_QUERY_AUTHORIZATION_CALLS)

        val resumed = resources.inventory(administratorId, UUID.randomUUID(), 1, capped.nextCursor)
        assertThat(resumed.items.map { it.id }).containsExactly(allowed)
    }

    @Test
    fun `schedule caps identity OPA calls and continues from its last examined tuple`() {
        val resource = createResource(capacity = 100)
        val requester = entity("capped-schedule-requester")
        repeat(ResourceService.MAX_QUERY_AUTHORIZATION_CALLS + 1) {
            jdbc.update(
                """INSERT INTO occ.resource_reservation
                   (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
                   VALUES (?, ?, ?, tstzrange(?::timestamptz, ?::timestamptz, '[)'), 1, false, 'PENDING')""",
                UUID.randomUUID(), resource.id, requester, instant(9), instant(10),
            )
        }
        val readBefore = decisionCount("occ.read")
        val identityBefore = decisionCount("occ.reservation.identity.read")

        val first = resources.schedule(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(11), 100, null)

        assertThat(first.items).hasSize(ResourceService.MAX_QUERY_AUTHORIZATION_CALLS - 1)
        assertThat(first.nextCursor).isNotNull()
        assertThat(decisionCount("occ.read") - readBefore).isEqualTo(1)
        assertThat(decisionCount("occ.reservation.identity.read") - identityBefore)
            .isEqualTo(ResourceService.MAX_QUERY_AUTHORIZATION_CALLS - 1L)
        val second = resources.schedule(
            administratorId, UUID.randomUUID(), resource.id, instant(8), instant(11), 100, first.nextCursor,
        )
        assertThat(second.items).hasSize(2)
        assertThat(second.nextCursor).isNull()
    }

    @Test
    fun `schedule cursor uses immutable creation order when consumed and unconsumed ranges move`() {
        val resource = createResource(capacity = 10)
        val requester = entity("moving-schedule-requester")
        val ids = List(3) { UUID.randomUUID() }
        ids.forEachIndexed { index, id ->
            jdbc.update(
                """INSERT INTO occ.resource_reservation
                   (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state, created_at)
                   VALUES (?, ?, ?, tstzrange(?::timestamptz, ?::timestamptz, '[)'), 1, false, 'PENDING', ?::timestamptz)""",
                id, resource.id, requester, instant(9 + index), instant(10 + index), instant(6).plusSeconds(index.toLong()),
            )
        }

        val first = resources.schedule(administratorId, UUID.randomUUID(), resource.id, instant(8), instant(13), 1, null)
        jdbc.update(
            "UPDATE occ.resource_reservation SET time_range = tstzrange(?::timestamptz, ?::timestamptz, '[)') WHERE id = ?",
            instant(12), instant(13), ids[0],
        )
        jdbc.update(
            "UPDATE occ.resource_reservation SET time_range = tstzrange(?::timestamptz, ?::timestamptz, '[)') WHERE id = ?",
            instant(8, 30), instant(9, 30), ids[1],
        )
        val appended = UUID.randomUUID()
        jdbc.update(
            """INSERT INTO occ.resource_reservation
               (id, resource_id, requester_entity_id, time_range, capacity, exclusive, state)
               VALUES (?, ?, ?, tstzrange(?::timestamptz, ?::timestamptz, '[)'), 1, false, 'PENDING')""",
            appended, resource.id, requester, instant(9, 30), instant(10, 30),
        )
        val second = resources.schedule(
            administratorId, UUID.randomUUID(), resource.id, instant(8), instant(13), 1, first.nextCursor,
        )
        val third = resources.schedule(
            administratorId, UUID.randomUUID(), resource.id, instant(8), instant(13), 1, second.nextCursor,
        )

        assertThat(first.items.map { it.id }).containsExactly(ids[0])
        assertThat(second.items.map { it.id }).containsExactly(ids[1])
        assertThat(third.items.map { it.id }).containsExactly(ids[2])
        assertThat(second.items.single().start).isEqualTo(instant(10))
        assertThat(third.items.single().start).isEqualTo(instant(11))
        assertThat(third.nextCursor).isNull()
        assertThat((first.items + second.items + third.items).map { it.id }).doesNotHaveDuplicates()
        assertThat((first.items + second.items + third.items).map { it.id }).doesNotContain(appended)
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM occ.resource_reservation_history WHERE reservation_id = ?",
            Long::class.java,
            ids[0],
        )).isEqualTo(2)
        assertThatThrownBy {
            jdbc.update("UPDATE occ.resource_reservation_history SET capacity = 9 WHERE reservation_id = ?", ids[0])
        }.hasRootCauseInstanceOf(org.postgresql.util.PSQLException::class.java)
    }

    @Test
    fun `first schedule page locks snapshot boundary against a transaction started writer`() {
        val resource = createResource()
        val requester = entity("snapshot-race-requester")
        val reservations = listOf(
            reserve(resource.id, requester, instant(9), instant(10), 1),
            reserve(resource.id, requester, instant(10), instant(11), 1),
            reserve(resource.id, requester, instant(11), instant(12), 1),
        )
        val writerStarted = CountDownLatch(1)
        val allowWriter = CountDownLatch(1)
        val writerFinished = CountDownLatch(1)
        val pageReady = CountDownLatch(1)
        val allowPageCommit = CountDownLatch(1)
        val transactions = TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!))
        val executor = Executors.newFixedThreadPool(2)
        try {
            val writer = executor.submit {
                transactions.executeWithoutResult {
                    jdbc.queryForObject("SELECT transaction_timestamp()", OffsetDateTime::class.java)
                    writerStarted.countDown()
                    check(allowWriter.await(10, TimeUnit.SECONDS))
                    jdbc.update(
                        """UPDATE occ.resource_reservation
                           SET time_range = tstzrange(?::timestamptz, ?::timestamptz, '[)'),
                               row_version = row_version + 1
                           WHERE id = ?""",
                        instant(12), instant(13), reservations[0].id,
                    )
                    writerFinished.countDown()
                }
            }
            check(writerStarted.await(10, TimeUnit.SECONDS))
            val firstPage = executor.submit<CursorPage<Reservation>> {
                transactions.execute {
                    resources.schedule(
                        administratorId, UUID.randomUUID(), resource.id, instant(8), instant(14), 1, null,
                    ).also {
                        pageReady.countDown()
                        check(allowPageCommit.await(10, TimeUnit.SECONDS))
                    }
                }!!
            }
            check(pageReady.await(10, TimeUnit.SECONDS))
            allowWriter.countDown()
            assertThat(writerFinished.await(1, TimeUnit.SECONDS)).isFalse()
            allowPageCommit.countDown()
            val first = firstPage.get(10, TimeUnit.SECONDS)
            writer.get(10, TimeUnit.SECONDS)

            val second = resources.schedule(
                administratorId, UUID.randomUUID(), resource.id, instant(8), instant(14), 1, first.nextCursor,
            )
            val third = resources.schedule(
                administratorId, UUID.randomUUID(), resource.id, instant(8), instant(14), 1, second.nextCursor,
            )
            val snapshot = first.items + second.items + third.items
            assertThat(snapshot.map { it.id }).containsExactlyElementsOf(reservations.map { it.id })
            assertThat(snapshot.map { it.start }).containsExactly(instant(9), instant(10), instant(11))
            assertThat(third.nextCursor).isNull()
        } finally {
            allowWriter.countDown()
            allowPageCommit.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `runtime reservation commands append history but direct history forgery is denied`() {
        val resource = createResource()
        val requester = entity("history-privilege-requester")
        val reservation = reserve(resource.id, requester, instant(9), instant(10), 1)
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM occ.resource_reservation_history WHERE reservation_id = ?",
            Long::class.java,
            reservation.id,
        )).isEqualTo(1)

        var forgery: Throwable? = null
        TransactionTemplate(DataSourceTransactionManager(jdbc.dataSource!!)).executeWithoutResult { status ->
            forgery = runCatching {
                jdbc.update(
                    """INSERT INTO occ.resource_reservation_history
                           (history_id, reservation_id, resource_id, requester_entity_id,
                            process_instance_id, task_id, time_range, capacity, exclusive, state,
                            row_version, created_at, updated_at, confirmed_at, cancelled_at, completed_at,
                            valid_from, valid_until)
                       SELECT ?, reservation_id, resource_id, requester_entity_id,
                              process_instance_id, task_id, time_range, capacity, exclusive, state,
                              row_version, created_at, updated_at, confirmed_at, cancelled_at, completed_at,
                              valid_from, valid_until
                       FROM occ.resource_reservation_history WHERE reservation_id = ? LIMIT 1""",
                    UUID.randomUUID(), reservation.id,
                )
            }.exceptionOrNull()
            status.setRollbackOnly()
        }
        assertThat(forgery).hasRootCauseInstanceOf(org.postgresql.util.PSQLException::class.java)
        val postgres = generateSequence(forgery) { it.cause }
            .filterIsInstance<org.postgresql.util.PSQLException>()
            .firstOrNull()
        assertThat(postgres?.sqlState).isEqualTo("42501")

        val change = ChangeReservationRequest(resource.id, instant(10), instant(11), 1.toBigDecimal(), false)
        resources.change(reservation.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(change), change)
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM occ.resource_reservation_history WHERE reservation_id = ?",
            Long::class.java,
            reservation.id,
        )).isEqualTo(2)
    }

    @Test
    fun `large temporal history schedule plan examines only the requested batch`() {
        val resource = createResource()
        val requester = entity("temporal-plan-requester")
        listOf(
            reserve(resource.id, requester, instant(9), instant(10), 1),
            reserve(resource.id, requester, instant(10), instant(11), 1),
            reserve(resource.id, requester, instant(11), instant(12), 1),
        )
        val noise = reserve(resource.id, requester, instant(12), instant(13), 1)
        repeat(400) { version ->
            jdbc.update(
                "UPDATE occ.resource_reservation SET capacity = ?, row_version = ? WHERE id = ?",
                if (version % 2 == 0) 2 else 1, version + 1L, noise.id,
            )
        }
        flywayJdbc.execute("VACUUM (ANALYZE) occ.resource_reservation_history")
        val snapshotAt = jdbc.queryForObject("SELECT clock_timestamp()", OffsetDateTime::class.java)!!
        val batchLimit = 2
        val planJson = jdbc.queryForObject(
            """EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
               SELECT reservation_id AS id, resource_id, requester_entity_id, process_instance_id, task_id,
                      lower(time_range) AS starts_at, upper(time_range) AS ends_at,
                      capacity, exclusive, state, row_version, created_at
               FROM occ.resource_reservation_history
               WHERE resource_id = ?
                 AND valid_from <= ?::timestamptz
                 AND (valid_until IS NULL OR valid_until > ?::timestamptz)
                 AND tstzrange(valid_from, valid_until, '[)') @> ?::timestamptz
                 AND state IN ('PENDING','CONFIRMED')
                 AND lower(time_range) < ?::timestamptz
                 AND upper(time_range) > ?::timestamptz
                 AND time_range && tstzrange(?::timestamptz, ?::timestamptz, '[)')
               ORDER BY lower(time_range), reservation_id
               LIMIT ?""",
            String::class.java,
            resource.id, snapshotAt, snapshotAt, snapshotAt,
            instant(14), instant(8), instant(8), instant(14), batchLimit,
        )!!
        val root = mapper.readTree(planJson).path(0).path("Plan")
        val nodes = mutableListOf<com.fasterxml.jackson.databind.JsonNode>()
        fun collect(node: com.fasterxml.jackson.databind.JsonNode) {
            nodes.add(node)
            node.path("Plans").forEach(::collect)
        }
        collect(root)

        val temporalIndex = nodes.singleOrNull {
            it.path("Index Name").asText() == "ix_resource_reservation_history_temporal_schedule"
        }
        assertThat(temporalIndex).describedAs(planJson).isNotNull
        assertThat(nodes).noneMatch {
            it.path("Node Type").asText() == "Seq Scan" &&
                it.path("Relation Name").asText() == "resource_reservation_history"
        }
        nodes.filter { it.path("Node Type").asText().contains("Sort") }.forEach { sort ->
            assertThat(sort.path("Plans").path(0).path("Actual Rows").asLong())
                .describedAs("sort input remains bounded: $planJson")
                .isLessThanOrEqualTo(batchLimit + 5L)
        }
        val examinedRows = requireNotNull(temporalIndex).path("Actual Rows").asLong() +
            temporalIndex.path("Rows Removed by Filter").asLong() +
            temporalIndex.path("Rows Removed by Index Recheck").asLong()
        assertThat(examinedRows).describedAs(planJson).isLessThanOrEqualTo(batchLimit + 5L)
        assertThat(root.has("Shared Hit Blocks")).isTrue()
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM occ.resource_reservation_history WHERE reservation_id = ?",
            Long::class.java,
            noise.id,
        )).isEqualTo(401)
    }

    @Test
    fun `reservation validates and authorizes requester process and task provenance transactionally`() {
        val resource = createResource()
        val requester = entity("workflow-requester")
        val workflow = workflowFixture()
        val valid = ReserveResourceRequest(
            UUID.randomUUID(), requester, workflow.processA, workflow.taskA,
            instant(9), instant(10), 1.toBigDecimal(), false,
        )
        val allowsBefore = decisionCount("occ.execute")

        resources.reserve(resource.id, metadata(), mapper.writeValueAsBytes(valid), valid)

        assertThat(decisionCount("occ.execute") - allowsBefore).isEqualTo(4)
        assertThatThrownBy {
            jdbc.update("UPDATE occ.task_projection SET process_instance_id = ? WHERE id = ?", workflow.processB, workflow.taskA)
        }.hasRootCauseInstanceOf(org.postgresql.util.PSQLException::class.java)
        val crossWorkflow = valid.copy(id = UUID.randomUUID(), processInstanceId = workflow.processB)
        assertThatThrownBy {
            resources.reserve(resource.id, metadata(), mapper.writeValueAsBytes(crossWorkflow), crossWorkflow)
        }.isInstanceOf(ResourceReferenceValidationException::class.java)
        assertThatThrownBy {
            jdbc.update(
                """INSERT INTO occ.resource_reservation
                   (id, resource_id, requester_entity_id, process_instance_id, task_id,
                    time_range, capacity, exclusive, state)
                   VALUES (?, ?, ?, ?, ?, tstzrange(?::timestamptz, ?::timestamptz, '[)'), 1, false, 'PENDING')""",
                UUID.randomUUID(), resource.id, requester, workflow.processB, workflow.taskA, instant(10), instant(11),
            )
        }.hasRootCauseInstanceOf(org.postgresql.util.PSQLException::class.java)
    }

    @Test
    fun `named reservation reference and duplicate constraints return bounded HTTP errors`() {
        val resource = createResource()
        val requester = entity("reference-requester")
        val phantomProcess = entity("phantom-process")
        val token = loginToken()
        val reservationId = UUID.randomUUID()

        fun postReservation(request: ReserveResourceRequest, key: String, expectedStatus: Int): String =
            mockMvc.post("/api/v1/resources/${resource.id}/reservations") {
                header("Authorization", "Bearer $token")
                header("X-Correlation-Id", UUID.randomUUID())
                header("Idempotency-Key", key)
                contentType = MediaType.APPLICATION_JSON
                content = mapper.writeValueAsBytes(request)
            }.andExpect { status { isEqualTo(expectedStatus) } }.andReturn().response.contentAsString

        val missingRequester = ReserveResourceRequest(
            UUID.randomUUID(), UUID.randomUUID(), null, null, instant(9), instant(10), 1.toBigDecimal(), false,
        )
        assertThat(postReservation(missingRequester, "missing-requester-${UUID.randomUUID()}", 400))
            .contains("OCC-RESOURCE-REFERENCE").doesNotContain("23503", "PSQLException")
        val missingProcess = missingRequester.copy(id = reservationId, requesterEntityId = requester, processInstanceId = phantomProcess)
        assertThat(postReservation(missingProcess, "missing-process-${UUID.randomUUID()}", 400))
            .contains("OCC-RESOURCE-REFERENCE")

        val valid = missingProcess.copy(processInstanceId = null)
        postReservation(valid, "reservation-first-${UUID.randomUUID()}", 201)
        assertThat(postReservation(valid, "reservation-duplicate-${UUID.randomUUID()}", 409))
            .contains("OCC-RESOURCE-ID-CONFLICT").doesNotContain("23505", "PSQLException")

        val availability = AddAvailabilityRequest(UUID.randomUUID(), instant(8), instant(18), AvailabilityMode.AVAILABLE, null)
        fun postAvailability(version: Long, key: String, expectedStatus: Int): String =
            mockMvc.post("/api/v1/resources/${resource.id}/availability") {
                header("Authorization", "Bearer $token")
                header("X-Correlation-Id", UUID.randomUUID())
                header("Idempotency-Key", key)
                header("Expected-Version", version)
                contentType = MediaType.APPLICATION_JSON
                content = mapper.writeValueAsBytes(availability)
            }.andExpect { status { isEqualTo(expectedStatus) } }.andReturn().response.contentAsString
        postAvailability(0, "availability-first-${UUID.randomUUID()}", 201)
        assertThat(postAvailability(1, "availability-duplicate-${UUID.randomUUID()}", 409))
            .contains("OCC-RESOURCE-ID-CONFLICT")

        val managedId = entity("duplicate-managed-resource")
        val managed = CreateResourceRequest(managedId, "ROOM", 1.toBigDecimal())
        fun postManaged(key: String, expectedStatus: Int): String = mockMvc.post("/api/v1/resources") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", key)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(managed)
        }.andExpect { status { isEqualTo(expectedStatus) } }.andReturn().response.contentAsString
        postManaged("managed-first-${UUID.randomUUID()}", 201)
        assertThat(postManaged("managed-duplicate-${UUID.randomUUID()}", 409))
            .contains("OCC-RESOURCE-ID-CONFLICT").doesNotContain("23505", "PSQLException")
    }

    @Test
    fun `change and cancel authorize supplied resource before revealing reservation existence`() {
        val resource = createResource()
        val otherResource = createResource()
        val requester = entity("oracle-requester")
        val reservation = reserve(resource.id, requester, instant(9), instant(10), 1)
        val token = loginToken()
        val missing = UUID.randomUUID()
        val change = ChangeReservationRequest(resource.id, instant(10), instant(11), 1.toBigDecimal(), false)

        fun change(id: UUID, request: ChangeReservationRequest): String = mockMvc.patch("/api/v1/reservations/$id") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "oracle-change-${UUID.randomUUID()}")
            header("Expected-Version", 0)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(request)
        }.andExpect { status { isNotFound() } }.andReturn().response.contentAsString

        val absent = change(missing, change)
        val wrongParent = change(reservation.id, change.copy(resourceId = otherResource.id))
        assertThat(absent).contains("OCC-RESERVATION-NOT-FOUND")
        assertThat(wrongParent).contains("OCC-RESERVATION-NOT-FOUND")

        val cancelled = mockMvc.post("/api/v1/reservations/$missing/cancel") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "oracle-cancel-${UUID.randomUUID()}")
            header("Expected-Version", 0)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(CancelReservationRequest(resource.id))
        }.andExpect { status { isNotFound() } }.andReturn().response.contentAsString
        assertThat(cancelled).contains("OCC-RESERVATION-NOT-FOUND")

        val requesterDeniedReservation = reserve(resource.id, requester, instant(11), instant(12), 1)
        val operator = operatorPrincipal()
        val operatorChange = ChangeReservationRequest(resource.id, instant(12), instant(13), 1.toBigDecimal(), false)
        val operatorMissing = runCatching {
            resources.change(
                UUID.randomUUID(), metadata(expectedVersion = 0).copy(principalId = operator),
                mapper.writeValueAsBytes(operatorChange), operatorChange,
            )
        }.exceptionOrNull()
        lockObserver.afterLockOnce(resource.id) {
            jdbc.update(
                """UPDATE authz.relationship SET revoked_at = transaction_timestamp()
                   WHERE relation_definition_id = ? AND subject_entity_id = ?
                     AND object_entity_id = ? AND revoked_at IS NULL""",
                BootstrapIds.ROLE_ASSIGNMENT_RELATION, operator, BootstrapIds.OPERATOR_ROLE,
            )
        }
        val denied = runCatching {
            resources.change(
                requesterDeniedReservation.id, metadata(expectedVersion = 0).copy(principalId = operator),
                mapper.writeValueAsBytes(operatorChange), operatorChange,
            )
        }.exceptionOrNull()
        assertThat(denied).isInstanceOf(ReservationNotFoundException::class.java)
        assertThat(operatorMissing).isInstanceOf(ReservationNotFoundException::class.java)
    }

    @Test
    fun `HTTP query boundaries return bounded validation problems before database access`() {
        val resource = createResource()
        val token = loginToken()
        val equal = instant(9)
        val reversedStart = instant(10)
        val reversedEnd = instant(9)
        val requests = listOf(
            "/api/v1/resources?limit=0",
            "/api/v1/resources?limit=101",
            "/api/v1/resources/${resource.id}/schedule?start=${instant(8)}&end=${instant(9)}&limit=0",
            "/api/v1/resources/${resource.id}/schedule?start=${instant(8)}&end=${instant(9)}&limit=101",
            "/api/v1/resources/${resource.id}/schedule?start=$equal&end=$equal&limit=1",
            "/api/v1/resources/${resource.id}/schedule?start=$reversedStart&end=$reversedEnd&limit=1",
            "/api/v1/resources/${resource.id}/availability?start=$equal&end=$equal",
            "/api/v1/resources/${resource.id}/availability?start=$reversedStart&end=$reversedEnd",
        )
        val decisionsBefore = jdbc.queryForObject(
            "SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?",
            Long::class.java,
            administratorId,
        )!!

        requests.forEach { path ->
            val body = mockMvc.get(path) {
                header("Authorization", "Bearer $token")
                header("X-Correlation-Id", UUID.randomUUID())
            }.andExpect { status { isBadRequest() } }.andReturn().response.contentAsString
            assertThat(body).contains("OCC-RESOURCE-QUERY-VALIDATION").doesNotContain("PSQLException", "Internal server error")
        }
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ?",
            Long::class.java,
            administratorId,
        )).isEqualTo(decisionsBefore)
    }

    @Test
    fun `exact capacity succeeds peak is not interval sum and conflicts are bounded and redacted`() {
        val resource = createResource(capacity = 10)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 6)
        reserve(resource.id, requester, instant(9, 30), instant(10), 4)
        reserve(resource.id, requester, instant(10), instant(11), 6)
        val identityDenialsBefore = jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log
               WHERE principal_entity_id = ? AND action_key = 'occ.reservation.identity.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )!!

        assertThatThrownBy { reserve(resource.id, requester, instant(9, 45), instant(10, 15), 1) }
            .isInstanceOfSatisfying(ReservationConflictException::class.java) { conflict ->
                assertThat(conflict.resourceId).isEqualTo(resource.id)
                assertThat(conflict.start).isEqualTo(instant(9, 45))
                assertThat(conflict.end).isEqualTo(instant(10, 15))
                assertThat(conflict.reservationId).isNull()
                assertThat(conflict.requesterEntityId).isNull()
                assertThat(conflict.message).doesNotContain(requester.toString())
            }
        assertThat(jdbc.queryForObject(
            """SELECT count(*) FROM authz.decision_log
               WHERE principal_entity_id = ? AND action_key = 'occ.reservation.identity.read' AND decision = 'DENY'""",
            Long::class.java,
            administratorId,
        )).isEqualTo(identityDenialsBefore + 1)
        val event = mapper.readTree(jdbc.queryForObject(
            """SELECT payload::text FROM audit.outbox_event
               WHERE aggregate_id IN (SELECT id FROM occ.resource_reservation WHERE resource_id = ?)
                 AND event_type = 'resource-reservation.created' ORDER BY created_at LIMIT 1""",
            String::class.java,
            resource.id,
        ))
        assertThat(event.path("state").textValue()).isEqualTo("PENDING")
        assertThat(event.path("start").textValue()).isNotBlank()
        assertThat(event.path("end").textValue()).isNotBlank()
        assertThat(event.path("capacity").decimalValue()).isPositive()
        assertThat(event.path("exclusive").isBoolean).isTrue()
    }

    @Test
    fun `stale commands fail replay is exact and reservation parent links stay immutable`() {
        val resource = createResource()
        val requester = entity("requester")
        val reservation = reserve(resource.id, requester, instant(9), instant(10), 2, key = "reserve-replay-${UUID.randomUUID()}")
        val change = ChangeReservationRequest(resource.id, instant(10), instant(11), 3.toBigDecimal(), false)
        val key = "change-${UUID.randomUUID()}"
        val metadata = metadata(key, expectedVersion = 0)

        val changed = resources.change(reservation.id, metadata, mapper.writeValueAsBytes(change), change)
        val replay = resources.change(reservation.id, metadata, mapper.writeValueAsBytes(change), change)
        assertThat(changed.body).isEqualTo(replay.body)
        assertThat(changed.status).isEqualTo(200)
        assertThat(changed.replayed).isFalse()
        assertThat(replay.replayed).isTrue()
        assertThat(changed.body.version).isEqualTo(1)
        assertThatThrownBy {
            val cancel = CancelReservationRequest(resource.id)
            resources.cancel(reservation.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(cancel), cancel)
        }.isInstanceOf(OptimisticConflictException::class.java)
        assertThatThrownBy {
            resources.change(
                reservation.id, metadata(key, expectedVersion = 1),
                mapper.writeValueAsBytes(change.copy(capacity = 4.toBigDecimal())), change.copy(capacity = 4.toBigDecimal()),
            )
        }.isInstanceOf(IdempotencyConflictException::class.java)
        assertThatThrownBy {
            jdbc.update("UPDATE occ.resource_reservation SET requester_entity_id = ? WHERE id = ?", entity("other"), reservation.id)
        }.hasRootCauseInstanceOf(org.postgresql.util.PSQLException::class.java)
    }

    @Test
    fun `capacity reduction archive maintenance and unavailable windows preserve active commitments`() {
        val resource = createResource(capacity = 10)
        val requester = entity("requester")
        reserve(resource.id, requester, instant(9), instant(10), 7)

        val reduce = UpdateResourceRequest(6.toBigDecimal(), ResourceState.AVAILABLE, resource.data)
        assertThatThrownBy {
            resources.update(resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(reduce), reduce)
        }.isInstanceOf(ReservationConflictException::class.java)

        val maintenance = UpdateResourceRequest(10.toBigDecimal(), ResourceState.MAINTENANCE, resource.data)
        val maintained = resources.update(
            resource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(maintenance), maintenance,
        ).body
        assertThat(maintained.state).isEqualTo(ResourceState.MAINTENANCE)
        assertThatThrownBy { reserve(resource.id, requester, instant(11), instant(12), 1) }
            .isInstanceOf(ReservationConflictException::class.java)

        val archivedResource = createResource()
        val archive = UpdateResourceRequest(10.toBigDecimal(), ResourceState.ARCHIVED, archivedResource.data)
        resources.update(archivedResource.id, metadata(expectedVersion = 0), mapper.writeValueAsBytes(archive), archive)
        assertThatThrownBy { reserve(archivedResource.id, requester, instant(11), instant(12), 1) }
            .isInstanceOf(ReservationConflictException::class.java)
    }

    @Test
    fun `terminal reservation and domain constraint SQL states map to bounded HTTP responses`() {
        val resource = createResource(capacity = 2)
        val requester = entity("terminal-requester")
        val reservation = reserve(resource.id, requester, instant(9), instant(10), 1)
        val token = loginToken()

        mockMvc.post("/api/v1/reservations/${reservation.id}/cancel") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "cancel-${UUID.randomUUID()}")
            header("Expected-Version", 0)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(CancelReservationRequest(resource.id))
        }.andExpect { status { isOk() } }

        val terminal = mockMvc.post("/api/v1/reservations/${reservation.id}/cancel") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "cancel-terminal-${UUID.randomUUID()}")
            header("Expected-Version", 1)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(CancelReservationRequest(resource.id))
        }.andExpect { status { isConflict() } }.andReturn().response.contentAsString
        assertThat(terminal).contains("OCC-RESERVATION-STATE-CONFLICT").doesNotContain("PSQLException", "55000")

        val constrainedReservation = reserve(resource.id, requester, instant(10), instant(11), 1)
        val invalid = ChangeReservationRequest(resource.id, instant(10), instant(11), 3.toBigDecimal(), false)
        val constrained = mockMvc.patch("/api/v1/reservations/${constrainedReservation.id}") {
            header("Authorization", "Bearer $token")
            header("X-Correlation-Id", UUID.randomUUID())
            header("Idempotency-Key", "invalid-capacity-${UUID.randomUUID()}")
            header("Expected-Version", 0)
            contentType = MediaType.APPLICATION_JSON
            content = mapper.writeValueAsBytes(invalid)
        }.andExpect { status { isBadRequest() } }.andReturn().response.contentAsString
        assertThat(constrained).contains("OCC-API-VALIDATION").doesNotContain("PSQLException", "23514")
    }

    private fun loginToken(): String {
        val response = mockMvc.post("/api/v1/auth/login") {
            header("X-Correlation-Id", UUID.randomUUID())
            contentType = MediaType.APPLICATION_JSON
            content = """{"username":"admin","password":"resource-bootstrap-test-only"}"""
        }.andExpect { status { isOk() } }.andReturn().response.contentAsString
        return mapper.readTree(response).path("accessToken").textValue()
    }

    private fun inventoryCursor(id: UUID, inclusive: Boolean): String = cursorCodec.encode(
        CursorContext(
            "resource.inventory", OutboxRepository.DEFAULT_CUSTOMER_INSTANCE_ID,
            CanonicalJsonObject.from(mapper.createObjectNode()), "resource-id", 1, CursorDirection.FORWARD,
        ),
        mapper.createArrayNode().add(id.toString()).add(inclusive),
    )

    private fun pagedId(index: Int): UUID = UUID.fromString(
        "f0000000-0000-7000-8000-${index.toString(16).padStart(12, '0')}",
    )

    private fun decisionCount(action: String): Long = jdbc.queryForObject(
        "SELECT count(*) FROM authz.decision_log WHERE principal_entity_id = ? AND action_key = ?",
        Long::class.java,
        administratorId,
        action,
    )!!

    private fun workflowFixture(): WorkflowFixture {
        val packageId = UUID.randomUUID()
        val packageVersion = UUID.randomUUID()
        flywayJdbc.update(
            "INSERT INTO catalog.domain_package(id, package_key, name, status) VALUES (?, ?, 'Resource fixture', 'ACTIVE')",
            packageId, "resource.${UUID.randomUUID()}",
        )
        flywayJdbc.update(
            "INSERT INTO catalog.package_version(id, package_id, semver, status) VALUES (?, ?, '1.0.0', 'DRAFT')",
            packageVersion, packageId,
        )
        val workflow = UUID.randomUUID()
        val binding = UUID.randomUUID()
        flywayJdbc.update(
            """INSERT INTO catalog.workflow_definition
               (id, package_version_id, workflow_key, bpmn_object_key, content_hash)
               VALUES (?, ?, ?, 'workflow.bpmn', ?)""",
            workflow, packageVersion, "resource-${UUID.randomUUID()}", "a".repeat(64),
        )
        jdbc.update(
            """INSERT INTO occ.process_definition_binding
               (id, workflow_definition_id, package_version_id, bpmn_key,
                flowable_deployment_id, flowable_definition_id, content_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            binding, workflow, packageVersion, "resource-${UUID.randomUUID()}",
            "deployment-${UUID.randomUUID()}", "definition-${UUID.randomUUID()}", "b".repeat(64),
        )
        fun process(label: String): UUID = entity(label).also { id ->
            jdbc.update(
                """INSERT INTO occ.process_instance
                   (id, definition_binding_id, package_version_id, flowable_instance_id, business_key, state)
                   VALUES (?, ?, ?, ?, ?, 'RUNNING')""",
                id, binding, packageVersion, "flowable-${UUID.randomUUID()}", "business-${UUID.randomUUID()}",
            )
        }
        val processA = process("process-a")
        val processB = process("process-b")
        val taskA = entity("task-a")
        jdbc.update(
            """INSERT INTO occ.task_projection(id, process_instance_id, activity_key, flowable_task_id, state)
               VALUES (?, ?, 'reserve', ?, 'CREATED')""",
            taskA, processA, "task-${UUID.randomUUID()}",
        )
        return WorkflowFixture(processA, processB, taskA)
    }

    private data class WorkflowFixture(val processA: UUID, val processB: UUID, val taskA: UUID)

    private fun operatorPrincipal(): UUID = entity("resource-operator").also { id ->
        jdbc.update(
            "INSERT INTO iam.principal(id, principal_kind, display_name, status) VALUES (?, 'USER', 'Resource Operator', 'ACTIVE')",
            id,
        )
        jdbc.update(
            """INSERT INTO authz.relationship
               (id, relation_definition_id, subject_entity_id, object_entity_id, source_kind, source_ref)
               VALUES (?, ?, ?, ?, 'SYSTEM', 'resource-integration-test')""",
            UUID.randomUUID(), BootstrapIds.ROLE_ASSIGNMENT_RELATION, id, BootstrapIds.OPERATOR_ROLE,
        )
    }
}
