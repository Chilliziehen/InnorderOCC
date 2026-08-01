package com.innorder.occ.config

import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.ApplicationListener
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component

@Component
@Profile("flowable-init")
class FlowableSchemaInitializationExit : ApplicationListener<ApplicationReadyEvent> {
    override fun onApplicationEvent(event: ApplicationReadyEvent) {
        (event.applicationContext as ConfigurableApplicationContext).close()
    }
}
