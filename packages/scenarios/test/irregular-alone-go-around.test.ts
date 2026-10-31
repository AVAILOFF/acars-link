// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { aloneOn, FLIGHTS } from './irregular-fixture.js';

// T14: each irregular scenario alone on the flight "go-around, pause, ×4".
aloneOn(FLIGHTS[1] as (typeof FLIGHTS)[number]);
