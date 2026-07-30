package com.innorder.occ.api

import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.ConstraintViolationException
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.validation.BindException
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

class OptimisticConflictException : RuntimeException {
    constructor() : super()
    constructor(message: String) : super(message)
}

@RestControllerAdvice
class ApiExceptionHandler(private val responses: OccProblemResponses) {
    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun methodArgumentNotValid(
        exception: MethodArgumentNotValidException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.validation(
        request,
        "${exception.bindingResult.errorCount.coerceAtMost(MAX_REPORTED_ERRORS)} request field(s) failed validation.",
    )

    @ExceptionHandler(BindException::class)
    fun bindException(exception: BindException, request: HttpServletRequest): ResponseEntity<OccProblem> =
        responses.validation(
            request,
            "${exception.bindingResult.errorCount.coerceAtMost(MAX_REPORTED_ERRORS)} request field(s) failed validation.",
        )

    @ExceptionHandler(ConstraintViolationException::class)
    fun constraintViolation(
        exception: ConstraintViolationException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.validation(
        request,
        "${exception.constraintViolations.size.coerceAtMost(MAX_REPORTED_ERRORS)} request constraint(s) failed validation.",
    )

    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun messageNotReadable(
        exception: HttpMessageNotReadableException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.validation(request, "Request body is malformed.")

    @ExceptionHandler(AuthenticationException::class)
    fun authentication(
        exception: AuthenticationException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.authentication(request)

    @ExceptionHandler(AccessDeniedException::class)
    fun accessDenied(
        exception: AccessDeniedException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.forbidden(request)

    @ExceptionHandler(OptimisticConflictException::class)
    fun conflict(
        exception: OptimisticConflictException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.conflict(request)

    @ExceptionHandler(Throwable::class)
    fun fallback(exception: Throwable, request: HttpServletRequest): ResponseEntity<OccProblem> =
        responses.internal(request)

    private companion object {
        const val MAX_REPORTED_ERRORS = 100
    }
}
