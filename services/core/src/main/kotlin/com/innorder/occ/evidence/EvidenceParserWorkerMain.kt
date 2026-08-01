package com.innorder.occ.evidence

import java.time.Clock

object EvidenceParserWorkerMain {
    @JvmStatic
    fun main(args: Array<String>) {
        require(args.contentEquals(arrayOf("--inspect")))
        inspect()
    }

    private fun inspect() {
        val request = ParserSandboxProtocol.readRequest(System.`in`)
        ParserSandboxProtocol.writeResult(System.out, DirectParserSandbox(Clock.systemUTC()).inspect(request))
    }
}
