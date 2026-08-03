package com.innorder.occ.config

import com.innorder.occ.api.OccProblemResponses
import com.innorder.occ.auth.AccessTokenAuthenticationConverter
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.security.web.AuthenticationEntryPoint
import org.springframework.security.web.access.AccessDeniedHandler
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.web.SecurityFilterChain

@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
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
        accessTokenAuthenticationConverter: AccessTokenAuthenticationConverter,
    ): SecurityFilterChain =
        http
            .csrf { it.disable() }
            .requestCache { it.disable() }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .exceptionHandling {
                it.authenticationEntryPoint(problemAuthenticationEntryPoint)
                it.accessDeniedHandler(problemAccessDeniedHandler)
            }
            .oauth2ResourceServer {
                it.authenticationEntryPoint(problemAuthenticationEntryPoint)
                it.jwt { jwt -> jwt.jwtAuthenticationConverter(accessTokenAuthenticationConverter) }
            }
            .authorizeHttpRequests {
                it.requestMatchers(
                    "/api/v1/system/status",
                    "/actuator/health/readiness",
                    "/api/v1/auth/login",
                    "/api/v1/auth/refresh",
                ).permitAll()
                it.requestMatchers("/actuator/**").hasAuthority(ACTUATOR_AUTHORITY)
                it.anyRequest().authenticated()
            }
            .build()

    private companion object {
        const val ACTUATOR_AUTHORITY = "OCC_ACTUATOR"
    }
}
