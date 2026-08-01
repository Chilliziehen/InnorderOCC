package com.innorder.occ.events

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import java.text.Normalizer

object EventPayloadPolicy {
    const val MAX_DEPTH = 32
    const val MAX_BYTES = 64 * 1024

    private val mapper = ObjectMapper().findAndRegisterModules()
    private val sensitiveNames = setOf(
        "password", "passphrase", "secret", "token", "authorization",
        "cookie", "apikey", "credential", "privatekey",
    )

    fun validate(payload: JsonNode, maxBytes: Int = MAX_BYTES) {
        if (payload !is ObjectNode || mapper.writeValueAsBytes(payload).size > maxBytes || !valid(payload, 0)) {
            throw InvalidEventPayloadException()
        }
    }

    fun sensitiveName(value: String): Boolean {
        val normalized = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase().filter(Char::isLetterOrDigit)
        return sensitiveNames.any(normalized::contains)
    }

    private fun valid(node: JsonNode, depth: Int): Boolean {
        if (depth > MAX_DEPTH) return false
        return when {
            node.isObject -> node.fields().asSequence().all { (name, value) ->
                validText(name) && !sensitiveName(name) && valid(value, depth + 1)
            }
            node.isArray -> node.all { valid(it, depth + 1) }
            node.isTextual -> validText(node.textValue())
            node.isNumber || node.isBoolean || node.isNull -> true
            else -> false
        }
    }

    private fun validText(value: String): Boolean = Normalizer.isNormalized(value, Normalizer.Form.NFC) &&
        value.codePoints().allMatch { it !in 0xD800..0xDFFF && it != 0xFEFF && (it >= 0x20 || it == 0x09) }
}

class InvalidEventPayloadException : RuntimeException("Event payload is invalid")
