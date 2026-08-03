package com.innorder.occ.api

internal object ApiContractValidation {
    fun isStandardUuid(value: String): Boolean {
        if (value.length != UUID_TEXT_LENGTH) return false
        for (index in value.indices) {
            if (index in UUID_HYPHEN_POSITIONS) {
                if (value[index] != '-') return false
            } else if (!value[index].isAsciiHexDigit()) {
                return false
            }
        }

        return value[UUID_VERSION_POSITION] in '1'..'8' &&
            value[UUID_VARIANT_POSITION].lowercaseChar() in "89ab" &&
            value != NIL_UUID
    }

    fun hasCodePointLengthWithin(value: String, min: Int, max: Int): Boolean {
        require(min >= 0 && max >= min)

        var codePoints = 0
        var index = 0
        while (index < value.length) {
            codePoints += 1
            if (codePoints > max) return false
            index += Character.charCount(Character.codePointAt(value, index))
        }
        return codePoints >= min
    }

    private fun Char.isAsciiHexDigit(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

    private const val UUID_TEXT_LENGTH = 36
    private const val UUID_VERSION_POSITION = 14
    private const val UUID_VARIANT_POSITION = 19
    private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"
    private val UUID_HYPHEN_POSITIONS = setOf(8, 13, 18, 23)
}
