package com.innorder.occ.evidence

import com.fasterxml.jackson.databind.ObjectMapper
import com.innorder.occ.api.CorrelationIdFilter
import com.innorder.occ.api.OccProblemResponses
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest
import java.util.UUID

class EvidenceProblemMappingTest {
    private val responses = OccProblemResponses(ObjectMapper().findAndRegisterModules())
    private val request = MockHttpServletRequest().apply {
        setAttribute(CorrelationIdFilter.REQUEST_ATTRIBUTE, UUID.randomUUID().toString())
    }

    @Test
    fun `evidence terminal failures map to exact contract problems`() {
        val tooLarge = responses.evidenceTooLarge(request).body!!
        assertThat(tooLarge.status).isEqualTo(413)
        assertThat(tooLarge.code).isEqualTo("OCC-EVIDENCE-TOO-LARGE")
        val digest = responses.evidenceDigestMismatch(request).body!!
        assertThat(digest.status).isEqualTo(422)
        assertThat(digest.code).isEqualTo("OCC-EVIDENCE-DIGEST-MISMATCH")
        val invalid = responses.evidenceInvalidContent(request).body!!
        assertThat(invalid.status).isEqualTo(422)
        assertThat(invalid.code).isEqualTo("OCC-EVIDENCE-INVALID-CONTENT")
    }

    @Test
    fun `invalid range returns contract headers without request details`() {
        val response = responses.evidenceInvalidRange(request, 123)
        assertThat(response.statusCode.value()).isEqualTo(416)
        assertThat(response.headers["Accept-Ranges"]).containsExactly("bytes")
        assertThat(response.headers["Content-Range"]).containsExactly("bytes */123")
        assertThat(response.body!!.code).isEqualTo("OCC-INVALID-REQUEST")
        assertThat(response.body!!.detail).isNull()
    }

    @Test
    fun `evidence conflicts use committed endpoint variants`() {
        assertThat(responses.evidenceUploadConflict(request).body!!.code)
            .isEqualTo("OCC-EVIDENCE-UPLOAD-CONFLICT")
        assertThat(responses.evidenceReviewConflict(request).body!!.code)
            .isEqualTo("OCC-EVIDENCE-REVIEW-CONFLICT")
    }
}
