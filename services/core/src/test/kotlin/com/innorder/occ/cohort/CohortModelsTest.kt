package com.innorder.occ.cohort

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import jakarta.validation.Validation
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import java.time.LocalDate
import java.util.UUID

class CohortModelsTest {
    private val mapper = ObjectMapper().findAndRegisterModules()
    private val validator = Validation.buildDefaultValidatorFactory().validator

    @Test
    fun `contract enums expose only canonical cohort values`() {
        assertThat(CohortStatus.entries.map { it.name }).containsExactly("DRAFT", "ACTIVE", "ARCHIVED")
        assertThat(CohortMemberRole.entries.map { it.name }).containsExactly("OWNER", "TEACHER", "PARTICIPANT")
    }

    @Test
    fun `create request rejects unknown fields and invalid date ranges`() {
        assertThatThrownBy {
            mapper.readValue<CreateCohortRequest>(
                """{"code":"alpha","name":"Alpha","packageVersionId":"$PACKAGE_ID","ownerPrincipalId":"$OWNER_ID","startDate":"2026-08-02","unexpected":true}""",
            )
        }.isInstanceOf(Exception::class.java)

        val request = mapper.readValue<CreateCohortRequest>(
            """{"code":"alpha","name":"Alpha","packageVersionId":"$PACKAGE_ID","ownerPrincipalId":"$OWNER_ID","startDate":"2026-08-03","endDate":"2026-08-02"}""",
        )
        assertThat(validator.validate(request)).extracting<String> { it.message }
            .contains("endDate must not precede startDate")
    }

    @Test
    fun `update request preserves explicit null end date and requires a mutable field`() {
        val clear = mapper.readValue<UpdateCohortRequest>("""{"expectedVersion":3,"endDate":null}""")
        val empty = mapper.readValue<UpdateCohortRequest>("""{"expectedVersion":3}""")

        assertThat(clear.endDateSpecified).isTrue()
        assertThat(clear.endDate).isNull()
        assertThat(validator.validate(clear)).isEmpty()
        assertThat(validator.validate(empty)).extracting<String> { it.message }
            .contains("at least one mutable field is required")
    }

    @Test
    fun `participant process starter is a framework neutral port`() {
        val calls = mutableListOf<ParticipantProcessStart>()
        val starter = ParticipantProcessStarter { request -> calls += request; UUID.randomUUID() }
        val request = ParticipantProcessStart(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), 4)

        starter.start(request)

        assertThat(calls).containsExactly(request)
        assertThat(ParticipantProcessStarter::class.java.declaredMethods.map { it.parameterTypes.toList() }.flatten())
            .noneMatch { it.name.startsWith("org.flowable") }
    }

    private companion object {
        val PACKAGE_ID: UUID = UUID.fromString("51000000-0000-7000-8000-000000000001")
        val OWNER_ID: UUID = UUID.fromString("56000000-0000-7000-8000-000000000001")
    }
}
