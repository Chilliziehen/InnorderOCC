package com.innorder.occ.evidence

import java.time.Clock

internal class DirectParserSandbox(private val clock: Clock) : ParserSandbox {
    override fun inspect(request: ParserSandboxRequest): ParserSandboxResult = try {
        val mediaType = when (request.format) {
            ParserFormat.PDF -> {
                PdfContentValidator(request.policy) { checkDeadline(request) }.validate(request.path)
                "application/pdf"
            }
            ParserFormat.ZIP -> ArchiveContentValidator(clock).validate(request)
        }
        ParserSandboxResult.Accepted(mediaType)
    } catch (rejected: EvidenceRejectedException) {
        ParserSandboxResult.Rejected(rejected.code)
    } catch (_: Exception) {
        ParserSandboxResult.Rejected(EvidenceRejectionCode.PARSER_SANDBOX_ERROR)
    }

    private fun checkDeadline(request: ParserSandboxRequest) {
        if (!clock.instant().isBefore(request.deadline)) throw EvidenceRejectedException(EvidenceRejectionCode.DEADLINE_EXCEEDED)
    }
}
