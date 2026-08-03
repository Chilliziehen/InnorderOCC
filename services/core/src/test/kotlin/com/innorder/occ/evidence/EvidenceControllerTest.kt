package com.innorder.occ.evidence

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class EvidenceControllerTest {
    @Test
    fun `range parser accepts one bounded byte range and rejects ambiguous ranges`() {
        assertThat(EvidenceHttpSupport.range("bytes=2-5", 10)).isEqualTo(ObjectRange(2, 4))
        assertThat(EvidenceHttpSupport.range("bytes=7-", 10)).isEqualTo(ObjectRange(7, 3))
        assertThatThrownBy { EvidenceHttpSupport.range("bytes=0-1,4-5", 10) }
            .isInstanceOf(InvalidEvidenceRequestException::class.java)
        assertThatThrownBy { EvidenceHttpSupport.range("bytes=10-11", 10) }
            .isInstanceOf(InvalidEvidenceRequestException::class.java)
    }

    @Test
    fun `attachment name cannot inject headers or paths`() {
        assertThat(EvidenceHttpSupport.attachment("../report\r\nX-Evil: yes.txt"))
            .isEqualTo("attachment; filename=\".._report__X-Evil_ yes.txt\"")
    }
}
