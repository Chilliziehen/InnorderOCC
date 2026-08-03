package com.innorder.occ.command

import com.fasterxml.jackson.databind.ObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class CanonicalJsonObjectTest {
    private val mapper = ObjectMapper().findAndRegisterModules()

    @Test
    fun `canonical object owns bytes and returns a fresh tree only on access`() {
        val source = mapper.readTree("""{"z":1,"a":{"y":2,"x":1}}""")
        val canonical = CanonicalJsonObject.from(source)
        (source as com.fasterxml.jackson.databind.node.ObjectNode).put("leak", true)

        val first = canonical.toJsonNode().also { it.put("leak", true) }
        val second = canonical.toJsonNode()

        assertThat(first.has("leak")).isTrue()
        assertThat(second.has("leak")).isFalse()
        assertThat(canonical.canonicalText()).isEqualTo("""{"a":{"x":1,"y":2},"z":1}""")
        assertThat(canonical).isEqualTo(CanonicalJsonObject.from(mapper.readTree("""{"a":{"x":1,"y":2},"z":1}""")))
        assertThat(canonical.digest).matches("^[0-9a-f]{64}${'$'}")
    }

    @Test
    fun `canonical object rejects nonobjects nonfinite ambiguous unicode and oversized values`() {
        listOf(
            mapper.readTree("[]"),
            mapper.createObjectNode().put("number", Double.NaN),
            mapper.createObjectNode().put("value", "e\u0301"),
            mapper.createObjectNode().put("value", "x".repeat(CanonicalJsonObject.MAX_BYTES)),
        ).forEach { value ->
            assertThatThrownBy { CanonicalJsonObject.from(value) }
                .isInstanceOf(InvalidCommandRequestException::class.java)
        }
    }
}
