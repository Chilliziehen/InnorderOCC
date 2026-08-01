package com.innorder.occ.evidence

import java.time.Clock

internal class DeterministicParserSandbox(clock: Clock) : ParserSandbox by DirectParserSandbox(clock)
