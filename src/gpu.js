// SPDX-License-Identifier: GPL-2.0-or-later
// Reports the load of the integrated GPU and, while it is awake, of the NVIDIA card, without
// ever being the reason the NVIDIA card is awake. Independent of GNOME Shell so it runs under
// plain gjs (tools/, tests/).
import {listNames, readText, runCommand} from './io.js';

const NVIDIA_PCI_DRIVER_DIR = '/sys/bus/pci/drivers/nvidia';
const DRM_CLASS_DIR = '/sys/class/drm';
const PCI_ADDRESS = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/;
const DRM_CARD = /^card\d+$/;

// "unsupported" means the kernel cannot runtime suspend the card, so it is always on. A card
// that is "suspending" or "resuming" is left alone.
const AWAKE_STATUSES = new Set(['active', 'unsupported']);

// nvidia-smi opens the card, and every open holds it awake for a while. Sampling an idle card
// on every tick would keep it powered for as long as the extension runs. An awake card that
// reports no load is therefore sampled only this often, which leaves it room to suspend
// between two samples. The gap is longer than every hold measured with driver 595: about
// 8 s after a query, 12 s after a client exits and 20 s after a wake-up.
export const IDLE_SAMPLE_GAP_SECONDS = 20;

// A card under load is awake anyway and is sampled on every tick. It keeps that rate for this
// long after its last non-zero sample, so a bursty workload does not read as idle.
export const IDLE_SETTLE_SECONDS = 3;

// A card that has just woken up is sampled on every tick for this long, whatever it reports.
// An application that wakes the card needs a few seconds before it starts to render, and
// backing off during those would hide its load for a whole idle gap. The samples cost
// nothing: after a wake-up the card stays up for about 20 s by itself.
export const WAKE_WATCH_SECONDS = 10;

// gpu_busy_percent covers a very short moment: on a lightly used desktop about half of the
// readings are 0 and the rest are scattered up to 100. One reading per second is noise, so
// the integrated GPU's load is the mean of the readings of this many seconds. Callers feed
// the window through observe().
export const INTEGRATED_WINDOW_SECONDS = 3;

// What GpuMonitor reads the machine through. Exported so tools can wrap it.
export const systemIo = Object.freeze({readText, runCommand});

// Both sources print whole percentages, one per line: gpu_busy_percent a single one,
// nvidia-smi one per queried card ("[N/A]" when it cannot tell). The busiest card wins.
export function parsePercent(text) {
    const percentages = (text ?? '').split('\n')
        .map(line => Number.parseInt(line, 10))
        .filter(Number.isFinite);
    return percentages.length > 0 ? Math.max(...percentages) : null;
}

// Decides on which ticks an awake NVIDIA card is queried. Times are in seconds.
export class DgpuSampleSchedule {
    #wakeTime = null;
    #lastSampleTime = null;
    #lastLoadTime = null;

    isDue(now) {
        if (this.#wakeTime === null || now - this.#wakeTime < WAKE_WATCH_SECONDS)
            return true;
        if (this.#lastLoadTime !== null && now - this.#lastLoadTime < IDLE_SETTLE_SECONDS)
            return true;
        return now - this.#lastSampleTime >= IDLE_SAMPLE_GAP_SECONDS;
    }

    record(load, now) {
        this.#wakeTime ??= now;
        if (load > 0)
            this.#lastLoadTime = now;
        this.#lastSampleTime = now;
    }

    // The card went to sleep; the next wake-up starts over.
    reset() {
        this.#wakeTime = null;
        this.#lastSampleTime = null;
        this.#lastLoadTime = null;
    }
}

// The integrated GPU is taken to be the boot VGA device. Its load is only available where the
// driver exposes gpu_busy_percent, which amdgpu does and the Intel drivers do not.
async function findIntegratedLoadPath(cancellable) {
    const cards = (await listNames(DRM_CLASS_DIR, cancellable)).filter(name => DRM_CARD.test(name));
    for (const card of cards.sort()) {
        const device = `${DRM_CLASS_DIR}/${card}/device`;
        if ((await readText(`${device}/boot_vga`, cancellable))?.trim() !== '1')
            continue;
        const loadPath = `${device}/gpu_busy_percent`;
        return await readText(loadPath, cancellable) === null ? null : loadPath;
    }
    return null;
}

export async function findGpus(cancellable = null) {
    const addresses = (await listNames(NVIDIA_PCI_DRIVER_DIR, cancellable))
        .filter(name => PCI_ADDRESS.test(name));
    return {
        nvidiaCards: addresses.sort().map(address => ({
            address,
            statusPath: `${NVIDIA_PCI_DRIVER_DIR}/${address}/power/runtime_status`,
        })),
        integratedLoadPath: await findIntegratedLoadPath(cancellable),
    };
}

// Times passed to the methods are monotonic and in seconds.
export class GpuMonitor {
    #nvidiaCards;
    #integratedLoadPath;
    #io;
    #schedule = new DgpuSampleSchedule();
    #nvidiaLoad = null;
    #integratedReadings = [];
    #warnedAboutNvidiaSmi = false;

    // gpus comes from findGpus(). io is replaceable so tests can stand in for sysfs and
    // nvidia-smi.
    constructor({nvidiaCards, integratedLoadPath}, io = systemIo) {
        this.#nvidiaCards = nvidiaCards;
        this.#integratedLoadPath = integratedLoadPath;
        this.#io = io;
    }

    get supported() {
        return this.#nvidiaCards.length > 0 || this.hasIntegratedLoad;
    }

    get hasIntegratedLoad() {
        return this.#integratedLoadPath !== null;
    }

    // Takes one reading of the integrated GPU for the mean that sample() reports. Meant to be
    // called several times per second; it costs one sysfs read.
    async observe(now, cancellable = null) {
        if (!this.hasIntegratedLoad)
            return;
        const percent = parsePercent(await this.#io.readText(this.#integratedLoadPath, cancellable));
        if (percent !== null)
            this.#integratedReadings.push({time: now, percent});
    }

    // Resolves to {integratedLoad, nvidiaAwake, nvidiaLoad}. Loads are fractions, or null where
    // they cannot be read; nvidiaLoad is also null while the card is not awake. Meant to be
    // called once per second.
    async sample(now, cancellable = null) {
        const integratedLoad = await this.#integratedLoad(now, cancellable);
        const awake = await this.#awakeNvidiaAddresses(cancellable);
        if (awake.length === 0) {
            this.#schedule.reset();
            this.#nvidiaLoad = null;
        } else if (this.#schedule.isDue(now)) {
            this.#nvidiaLoad = await this.#queryNvidiaLoad(awake, cancellable);
            this.#schedule.record(this.#nvidiaLoad, now);
        }
        return {integratedLoad, nvidiaAwake: awake.length > 0, nvidiaLoad: this.#nvidiaLoad};
    }

    async #awakeNvidiaAddresses(cancellable) {
        const awake = [];
        for (const {address, statusPath} of this.#nvidiaCards) {
            const status = (await this.#io.readText(statusPath, cancellable))?.trim();
            if (AWAKE_STATUSES.has(status))
                awake.push(address);
        }
        return awake;
    }

    // Taking a reading here as well gives a caller that never calls observe() a mean of the
    // last few samples.
    async #integratedLoad(now, cancellable) {
        await this.observe(now, cancellable);
        this.#integratedReadings = this.#integratedReadings
            .filter(reading => now - reading.time < INTEGRATED_WINDOW_SECONDS);
        if (this.#integratedReadings.length === 0)
            return null;
        const sum = this.#integratedReadings.reduce((total, reading) => total + reading.percent, 0);
        return sum / this.#integratedReadings.length / 100;
    }

    // Only the cards that are already awake are named, so a second card that sleeps stays
    // asleep.
    async #queryNvidiaLoad(addresses, cancellable) {
        const stdout = await this.#io.runCommand(['nvidia-smi', `--id=${addresses.join(',')}`,
            '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], cancellable);
        if (stdout === null && !this.#warnedAboutNvidiaSmi) {
            this.#warnedAboutNvidiaSmi = true;
            console.warn('Panel Stats: nvidia-smi failed, the NVIDIA load is not available');
        }
        const percent = parsePercent(stdout);
        return percent === null ? null : percent / 100;
    }
}
