// SPDX-License-Identifier: GPL-2.0-or-later
// Prints what the GPU sections would show, once per second, without GNOME Shell:
//   gjs -m tools/sample.js [seconds]
// A "*" marks the seconds in which nvidia-smi ran. The dGPU column is read after each sample,
// so together they show whether sampling keeps the card awake.
import GLib from 'gi://GLib';

import {GpuMonitor, findGpus, systemIo} from '../src/gpu.js';

// The same rhythm as the panel: one sample per second, observations in between.
const OBSERVE_INTERVAL_MS = 200;
const OBSERVATIONS_PER_SECOND = 1000 / OBSERVE_INTERVAL_MS;

const seconds = Number(ARGV[0] ?? 30);
const gpus = await findGpus();
print(`NVIDIA cards: ${gpus.nvidiaCards.map(card => card.address).join(', ') || '(none)'}`);
print(`integrated load: ${gpus.integratedLoadPath ?? '(not available)'}`);

let queried = false;
const monitor = new GpuMonitor(gpus, {
    ...systemIo,
    runCommand: (...args) => {
        queried = true;
        return systemIo.runCommand(...args);
    },
});
print(`supported: ${monitor.supported}\n`);

function now() {
    return GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
}

function percent(load) {
    return (load === null ? '–' : `${Math.round(load * 100)}%`).padStart(4);
}

function sleep(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function dgpuStatus() {
    return gpus.nvidiaCards
        .map(card => new TextDecoder().decode(GLib.file_get_contents(card.statusPath)[1]).trim())
        .join(',') || '-';
}

for (let second = 0; second < seconds; second++) {
    queried = false;
    const {integratedLoad, nvidiaAwake, nvidiaLoad} = await monitor.sample(now());
    const nvidia = nvidiaAwake ? `NVIDIA ${percent(nvidiaLoad)}` : '';
    print(`${String(second).padStart(3)}s ${queried ? '*' : ' '} integrated ${percent(integratedLoad)}  ` +
        `${nvidia.padEnd(11)}  dGPU ${dgpuStatus()}`);
    for (let i = 1; i < OBSERVATIONS_PER_SECOND; i++) {
        await sleep(OBSERVE_INTERVAL_MS);
        await monitor.observe(now());
    }
    await sleep(OBSERVE_INTERVAL_MS);
}
