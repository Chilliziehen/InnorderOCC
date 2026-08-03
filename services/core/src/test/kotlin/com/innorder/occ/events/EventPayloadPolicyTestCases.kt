package com.innorder.occ.events

import org.junit.jupiter.params.provider.Arguments
import java.util.stream.Stream

object EventPayloadPolicyTestCases {
    private val sensitiveNames = listOf(
        "password", "passwd", "passphrase", "secret", "token", "authorization",
        "cookie", "apikey", "credential", "privatekey",
    )

    @JvmStatic
    fun normalizedSensitiveFields(): Stream<Arguments> = sensitiveNames.stream().map { name ->
        Arguments.of(name, name.toCharArray().joinToString("-").uppercase())
    }
}
