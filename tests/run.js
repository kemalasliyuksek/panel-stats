// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the Shell-independent code: gjs -m tests/run.js
import System from 'system';

import {run} from './harness.js';
import './gpu.test.js';

System.exit(await run() === 0 ? 0 : 1);
