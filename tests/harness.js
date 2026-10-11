// SPDX-License-Identifier: GPL-2.0-or-later
// A minimal test harness for gjs: test files register their cases, tests/run.js runs them.
const tests = [];

export function test(name, body) {
    tests.push({name, body});
}

export function assertEquals(actual, expected, what) {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e)
        throw new Error(`${what}: expected ${e}, got ${a}`);
}

// Resolves to the number of failed tests.
export async function run() {
    let failed = 0;
    for (const {name, body} of tests) {
        try {
            await body();
            print(`ok    ${name}`);
        } catch (error) {
            failed++;
            print(`FAIL  ${name}\n      ${error.message}`);
        }
    }
    print(`\n${tests.length - failed} of ${tests.length} passed`);
    return failed;
}
