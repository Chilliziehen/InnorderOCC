import io

p = 'services/core/src/main/kotlin/com/innorder/occ/resource/ResourceService.kt'
s = io.open(p, encoding='utf-8').read()

pairs = []

pairs.append((
"""    private fun createCommand(request: CreateResourceRequest) = object : ResourceCommand(request.id, request.id, request.id, false) {
        override fun lockCurrentVersion(context: CommandContext): Long? {
            repository.lockResourceEntity(request.id)
            return null
        }

        override fun execute(context: CommandContext): CommandMutation = mutation(
            repository.insertResource(request), null, 0, 201, "resource.created",
        )
    }""",
"""    private fun createCommand(request: CreateResourceRequest) = object : ResourceCommand(request.id, request.id, request.id, false) {
        override val lockPlan = AggregateLockPlan(
            created = listOf(AggregateReference(MANAGED_RESOURCE_AGGREGATE_TYPE, request.id)),
        )

        override fun execute(context: CommandContext): CommandMutation {
            repository.lockResourceEntity(request.id)
            return mutation(repository.insertResource(request), 0, 1, 201, "resource.created")
        }
    }"""))

pairs.append((
"""        override fun lockCurrentVersion(context: CommandContext): Long? = repository.lockResource(id)
        override fun execute(context: CommandContext): CommandMutation {""",
"""        override val lockPlan = AggregateLockPlan(
            existing = listOf(AggregateReference(MANAGED_RESOURCE_AGGREGATE_TYPE, id)),
        )

        override fun execute(context: CommandContext): CommandMutation {"""))

pairs.append((
"""            override fun lockCurrentVersion(context: CommandContext): Long? = repository.lockResource(resourceId)
            override fun execute(context: CommandContext): CommandMutation {""",
"""            override val lockPlan = AggregateLockPlan(
                existing = listOf(AggregateReference(MANAGED_RESOURCE_AGGREGATE_TYPE, resourceId)),
            )

            override fun execute(context: CommandContext): CommandMutation {"""))

pairs.append((
"""            override fun lockCurrentVersion(context: CommandContext): Long? {
                if (repository.lockResource(resourceId) == null) throw InvalidCommandRequestException()
                if (!repository.lockReservationProvenance(request)) throw ResourceReferenceValidationException()
                authorizeRequired(context.metadata.principalId, context.metadata.correlationId, request.requesterEntityId, resourceId, WRITE_ACTION)
                request.processInstanceId?.let {
                    authorizeRequired(context.metadata.principalId, context.metadata.correlationId, it, resourceId, WRITE_ACTION)
                }
                request.taskId?.let {
                    authorizeRequired(context.metadata.principalId, context.metadata.correlationId, it, resourceId, WRITE_ACTION)
                }
                return null
            }

            override fun execute(context: CommandContext): CommandMutation = reservationMutation(
                repository.insertReservation(resourceId, request), null, 0, 201, "resource-reservation.created",
            )""",
"""            override val lockPlan = AggregateLockPlan(
                existing = listOf(AggregateReference(MANAGED_RESOURCE_AGGREGATE_TYPE, resourceId)),
                created = listOf(AggregateReference(RESOURCE_RESERVATION_AGGREGATE_TYPE, request.id)),
            )

            override fun execute(context: CommandContext): CommandMutation {
                if (!repository.lockReservationProvenance(request)) throw ResourceReferenceValidationException()
                authorizeRequired(context.metadata.principalId, context.metadata.correlationId, request.requesterEntityId, resourceId, WRITE_ACTION)
                request.processInstanceId?.let {
                    authorizeRequired(context.metadata.principalId, context.metadata.correlationId, it, resourceId, WRITE_ACTION)
                }
                request.taskId?.let {
                    authorizeRequired(context.metadata.principalId, context.metadata.correlationId, it, resourceId, WRITE_ACTION)
                }
                return reservationMutation(
                    repository.insertReservation(resourceId, request), 0, 1, 201, "resource-reservation.created",
                )
            }"""))

pairs.append((
"""            override fun lockCurrentVersion(context: CommandContext): Long? {
                if (repository.lockResource(request.resourceId) == null) throw InvalidCommandRequestException()
                val reservation = repository.lockReservation(id, request.resourceId) ?: throw ReservationNotFoundException()
                authorizeRequesterMutation(context, reservation)
                return reservation.version
            }

            override fun execute(context: CommandContext): CommandMutation {""",
"""            override val lockPlan = AggregateLockPlan(
                existing = listOf(
                    AggregateReference(MANAGED_RESOURCE_AGGREGATE_TYPE, request.resourceId),
                    AggregateReference(RESOURCE_RESERVATION_AGGREGATE_TYPE, id),
                ),
            )

            override fun execute(context: CommandContext): CommandMutation {
                val reservation = repository.lockReservation(id, request.resourceId) ?: throw ReservationNotFoundException()
                authorizeRequesterMutation(context, reservation)"""))

pairs.append((
"""            override fun lockCurrentVersion(context: CommandContext): Long? {
                if (repository.lockResource(resourceId) == null) throw InvalidCommandRequestException()
                val reservation = repository.lockReservation(id, resourceId) ?: throw ReservationNotFoundException()
                authorizeRequesterMutation(context, reservation)
                return reservation.version
            }

            override fun execute(context: CommandContext): CommandMutation {""",
"""            override val lockPlan = AggregateLockPlan(
                existing = listOf(
                    AggregateReference(MANAGED_RESOURCE_AGGREGATE_TYPE, resourceId),
                    AggregateReference(RESOURCE_RESERVATION_AGGREGATE_TYPE, id),
                ),
            )

            override fun execute(context: CommandContext): CommandMutation {
                val reservation = repository.lockReservation(id, resourceId) ?: throw ReservationNotFoundException()
                authorizeRequesterMutation(context, reservation)"""))

# The mutation helper now reports aggregate changes and binds each event to its
# aggregate, matching the command kernel contract.
pairs.append((
"""        return CommandMutation(
            status, response, resourceId, aggregateId, aggregateType, before, after, null,
            CanonicalJsonObject.from(mapper.createObjectNode().apply { put("version", after) }),
            listOf(PendingEventSpec(eventType, 1, event, after)),
        )""",
"""        val aggregate = AggregateReference(aggregateType, aggregateId)
        return CommandMutation(
            status, response, resourceId,
            listOf(AggregateChange(aggregate, before ?: 0, after)),
            null,
            CanonicalJsonObject.from(mapper.createObjectNode().apply { put("version", after) }),
            listOf(PendingEventSpec(eventType, 1, event, aggregate, after)),
        )"""))

for old, new in pairs:
    if old not in s:
        raise SystemExit('pattern not found:\n' + old[:160])
    s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('resource ported; remaining lockCurrentVersion:', s.count('lockCurrentVersion'))
