package com.innorder.occ.auth

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonAnySetter
import jakarta.validation.Valid
import jakarta.validation.constraints.AssertTrue
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import org.springframework.http.ResponseEntity
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@JsonIgnoreProperties(ignoreUnknown = false)
class LoginRequest(
    @field:NotBlank
    @field:Size(max = 128)
    @field:Pattern(regexp = "^(?=.*[!-~])[ -~]{1,128}${'$'}")
    val username: String,
    val password: String,
) {
    @get:AssertTrue(message = "password has invalid length")
    val passwordValid: Boolean
        get() = passwordCodePoints() in 12..128

    private fun passwordCodePoints(): Int = password.codePointCount(0, password.length)

    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?) {
        throw IllegalArgumentException("Unknown request field")
    }

    override fun toString(): String = "LoginRequest(username=$username, password=[REDACTED])"
}

@JsonIgnoreProperties(ignoreUnknown = false)
class RefreshRequest(
    @field:Size(min = 43, max = 43)
    @field:Pattern(regexp = "^[A-Za-z0-9_-]{43}${'$'}")
    val refreshToken: String,
) {
    @JsonAnySetter
    fun rejectUnknown(name: String, value: Any?) {
        throw IllegalArgumentException("Unknown request field")
    }

    override fun toString(): String = "RefreshRequest(refreshToken=[REDACTED])"
}

@RestController
@RequestMapping("/api/v1/auth")
class AuthController(private val auth: AuthService) {
    @PostMapping("/login")
    fun login(@Valid @RequestBody request: LoginRequest): ResponseEntity<TokenResponse> =
        ResponseEntity.ok(auth.login(request.username, request.password))

    @PostMapping("/refresh")
    fun refresh(@Valid @RequestBody request: RefreshRequest): ResponseEntity<TokenResponse> =
        ResponseEntity.ok(auth.refresh(request.refreshToken))

    @PostMapping("/logout")
    fun logout(
        authentication: Authentication,
        @Valid @RequestBody request: RefreshRequest,
    ): ResponseEntity<Void> {
        auth.logout(authentication.principal as AccessTokenPrincipal, request.refreshToken)
        return ResponseEntity.noContent().build()
    }
}
