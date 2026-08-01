package com.innorder.occ.api

import com.innorder.occ.auth.InvalidCredentialsException
import com.innorder.occ.authz.AuthorizationAvailabilityException
import com.innorder.occ.authz.AuthorizationDeniedException
import com.innorder.occ.command.IdempotencyConflictException
import com.innorder.occ.command.IdempotencyInProgressException
import com.innorder.occ.command.InvalidIdempotencyKeyException
import com.innorder.occ.command.InvalidCommandMetadataException
import com.innorder.occ.command.InvalidCommandRequestException
import com.innorder.occ.command.InvalidExpectedVersionException
import com.innorder.occ.command.IdempotencyExpiredException
import com.innorder.occ.command.CommandIntegrityException
import com.innorder.occ.resource.ReservationConflictException
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.ConstraintViolationException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.security.access.AccessDeniedException
import org.springframework.security.core.AuthenticationException
import org.springframework.validation.BindException
import org.springframework.web.ErrorResponse
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import java.util.Collections
import java.util.IdentityHashMap

class OptimisticConflictException : RuntimeException {
    constructor() : super()
    constructor(message: String) : super(message)
}

@RestControllerAdvice
class ApiExceptionHandler(
    private val responses: OccProblemResponses,
    private val failureReporter: ApiFailureReporter,
) {
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

    @ExceptionHandler(InvalidCredentialsException::class)
    fun invalidCredentials(
        exception: InvalidCredentialsException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.invalidCredentials(request)

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

    @ExceptionHandler(InvalidIdempotencyKeyException::class)
    fun invalidIdempotencyKey(
        exception: InvalidIdempotencyKeyException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.invalidIdempotencyKey(request)

    @ExceptionHandler(
        InvalidCommandRequestException::class,
        InvalidExpectedVersionException::class,
    )
    fun invalidCommand(
        exception: RuntimeException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.validation(request, "Command request is invalid.")

    @ExceptionHandler(InvalidCommandMetadataException::class)
    fun invalidCommandMetadata(
        exception: InvalidCommandMetadataException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.invalidCommandMetadata(request)

    @ExceptionHandler(IdempotencyConflictException::class)
    fun idempotencyConflict(
        exception: IdempotencyConflictException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.idempotencyConflict(request)

    @ExceptionHandler(IdempotencyInProgressException::class)
    fun idempotencyInProgress(
        exception: IdempotencyInProgressException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.idempotencyInProgress(request)

    @ExceptionHandler(IdempotencyExpiredException::class)
    fun idempotencyExpired(
        exception: IdempotencyExpiredException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.idempotencyExpired(request)

    @ExceptionHandler(CommandIntegrityException::class)
    fun commandIntegrity(
        exception: CommandIntegrityException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.commandIntegrity(request)

    @ExceptionHandler(com.innorder.occ.command.OptimisticConflictException::class)
    fun optimisticConflict(
        exception: com.innorder.occ.command.OptimisticConflictException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.optimisticConflict(request, exception.currentVersion)

    @ExceptionHandler(ReservationConflictException::class)
    fun reservationConflict(
        exception: ReservationConflictException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.reservationConflict(
        request, exception.resourceId.toString(), exception.start.toString(), exception.end.toString(),
    )

    @ExceptionHandler(AuthorizationDeniedException::class)
    fun authorizationDenied(
        exception: AuthorizationDeniedException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.forbidden(request)

    @ExceptionHandler(AuthorizationAvailabilityException::class)
    fun authorizationUnavailable(
        exception: AuthorizationAvailabilityException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.authorizationUnavailable(request)

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun typeMismatch(
        exception: MethodArgumentTypeMismatchException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.requestError(request, HttpStatus.BAD_REQUEST)

    @ExceptionHandler(InvalidCursorException::class)
    fun invalidCursor(
        exception: InvalidCursorException,
        request: HttpServletRequest,
    ): ResponseEntity<OccProblem> = responses.requestError(request, HttpStatus.BAD_REQUEST)

    @ExceptionHandler(Exception::class)
    fun fallback(exception: Exception, request: HttpServletRequest): ResponseEntity<OccProblem> {
        rethrowJvmError(exception)
        if (exception is ErrorResponse && exception.statusCode.is4xxClientError) {
            return responses.requestError(request, exception.statusCode)
        }
        failureReporter.report(responses.correlationId(request), exception.javaClass.name)
        return responses.internal(request)
    }

    private fun rethrowJvmError(exception: Exception) {
        val visited = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        var current: Throwable? = exception
        while (current != null && visited.add(current)) {
            if (current is Error) throw current
            current = current.cause
        }
    }

    private companion object {
        const val MAX_REPORTED_ERRORS = 100
    }
}
