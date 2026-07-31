package com.innorder.occ.iam

import com.innorder.occ.auth.AccessTokenPrincipal
import com.innorder.occ.auth.AuthService
import org.springframework.security.core.Authentication
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/me")
class CurrentUserController(private val auth: AuthService) {
    @GetMapping
    fun currentUser(authentication: Authentication): CurrentUser =
        auth.currentUser((authentication.principal as AccessTokenPrincipal).principalId)
}
