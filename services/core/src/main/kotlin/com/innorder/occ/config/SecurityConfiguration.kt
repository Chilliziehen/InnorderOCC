package com.innorder.occ.config

import com.innorder.occ.api.OccProblemResponses
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.access.AccessDeniedHandler
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.web.SecurityFilterChain

@Configuration
class SecurityConfiguration {
    @Bean
    fun problemAuthenticationEntryPoint(responses: OccProblemResponses): AuthenticationEntryPoint =
        AuthenticationEntryPoint { request, response, _ -> responses.writeAuthenticationRequired(request, response) }

    @Bean
    fun problemAccessDeniedHandler(responses: OccProblemResponses): AccessDeniedHandler =
        AccessDeniedHandler { request, response, _ -> responses.writeAccessDenied(request, response) }

    @Bean
    fun securityFilterChain(
        http: HttpSecurity,
        problemAuthenticationEntryPoint: AuthenticationEntryPoint,
        problemAccessDeniedHandler: AccessDeniedHandler,
    ): SecurityFilterChain =
        http
            .csrf { it.disable() }
            .requestCache { it.disable() }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .exceptionHandling {
                it.authenticationEntryPoint(problemAuthenticationEntryPoint)
                it.accessDeniedHandler(problemAccessDeniedHandler)
            }
            .authorizeHttpRequests {
                it.requestMatchers(
                    "/api/v1/system/status",
                    "/actuator/health/readiness",
                ).permitAll()
                it.requestMatchers("/actuator/**").hasAuthority(ACTUATOR_AUTHORITY)
                it.anyRequest().authenticated()
            }
            .build()

    private companion object {
        const val ACTUATOR_AUTHORITY = "OCC_ACTUATOR"
    }
}
