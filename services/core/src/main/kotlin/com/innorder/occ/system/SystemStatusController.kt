package com.innorder.occ.system

import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/system")
class SystemStatusController(
    private val systemStatusService: SystemStatusService,
) {
    @GetMapping("/status", produces = [MediaType.APPLICATION_JSON_VALUE])
    fun getStatus(): SystemStatus = systemStatusService.currentStatus()
}
