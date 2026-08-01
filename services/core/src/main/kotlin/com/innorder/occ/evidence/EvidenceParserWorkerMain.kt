package com.innorder.occ.evidence

import java.time.Clock

object EvidenceParserWorkerMain {
    @JvmStatic
    fun main(args: Array<String>) {
        require(args.size == 1)
        when (args.single()) {
            "--capabilities" -> printCapabilities()
            "--inspect" -> inspect()
            else -> error("unknown parser worker operation")
        }
    }

    private fun printCapabilities() {
        val networkIsolated = System.getenv("OCC_PARSER_NETWORK_ISOLATED").equals("true", ignoreCase = true)
        print(
            "protocol=1\n" +
                "processIsolation=true\n" +
                "networkIsolation=$networkIsolated\n" +
                "memoryLimitBytes=${Runtime.getRuntime().maxMemory()}\n",
        )
    }

    private fun inspect() {
        require(System.getenv("OCC_PARSER_NETWORK_ISOLATED").equals("true", ignoreCase = true))
        val request = ParserSandboxProtocol.readRequest(System.`in`)
        ParserSandboxProtocol.writeResult(System.out, DirectParserSandbox(Clock.systemUTC()).inspect(request))
    }
}
