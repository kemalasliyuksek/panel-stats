// SPDX-License-Identifier: GPL-2.0-or-later
// Prints the ranking the top consumer section is taken from, without GNOME Shell:
//   gjs -m tools/top.js [samples] [rows]
// The last column is what one sample costs this process, in wall time and in CPU time.
import GLib from 'gi://GLib';

import {TopMonitor} from '../src/top.js';

const INTERVAL_SECONDS = 3;
const samples = Number(ARGV[0] ?? 5);
const rows = Number(ARGV[1] ?? 5);
const monitor = new TopMonitor();

function now() {
    return GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
}

function cpuSeconds() {
    const fields = new TextDecoder().decode(GLib.file_get_contents('/proc/self/stat')[1]).split(') ')[1].split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100;
}

function memory(bytes) {
    return bytes === null ? '        –' : `${(bytes / 2 ** 30).toFixed(2).padStart(6)} GB`;
}

function sleep(seconds) {
    return new Promise(resolve => {
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

for (let i = 0; i <= samples; i++) {
    const [startWall, startCpu] = [now(), cpuSeconds()];
    const {leader, ranking} = await monitor.sample(now());
    const cost = `${Math.round((now() - startWall) * 1000)} ms wall, ${Math.round((cpuSeconds() - startCpu) * 1000)} ms CPU`;
    if (i === 0) {
        print(`first sample (counters only): ${cost}`);
    } else {
        print(`\nsample ${i}: ${ranking.length} entries, ${cost}; leader: ${leader?.label ?? '(none)'}`);
        for (const entry of ranking.slice(0, rows)) {
            print(`  ${entry.label.padEnd(26).slice(0, 26)} cpu ${(entry.cpuShare * 100).toFixed(1).padStart(5)}%  ` +
                `mem ${memory(entry.memoryBytes)}  ` +
                `score ${(entry.score * 100).toFixed(2).padStart(6)}  ${entry.reason}`);
        }
    }
    if (i < samples)
        await sleep(INTERVAL_SECONDS);
}
