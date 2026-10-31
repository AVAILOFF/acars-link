// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { aloneOn, FLIGHTS } from './irregular-fixture.js';

// T14: each irregular scenario alone on the flight "lbs OFP, telemetry gap".
aloneOn(FLIGHTS[2] as (typeof FLIGHTS)[number]);
