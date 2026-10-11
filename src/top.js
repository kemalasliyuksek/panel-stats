// SPDX-License-Identifier: GPL-2.0-or-later
// Ranks the applications and services of the machine by how much they weigh on it right now.
// Independent of GNOME Shell so it runs under plain gjs (tools/, tests/).
//
// What is ranked are control groups, not processes: systemd puts every application and every
// service into a cgroup of its own, and the kernel keeps CPU time and memory per cgroup. An
// application made of dozens of processes is one entry, and reading the counters of about a
// hundred cgroups is far cheaper than walking several hundred processes.
import GLib from 'gi://GLib';

import {listNames, readText} from './io.js';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MEMINFO_PATH = '/proc/meminfo';
const CPU_PRESSURE_PATH = '/proc/pressure/cpu';
const MEMORY_PRESSURE_PATH = '/proc/pressure/memory';

export const Reason = Object.freeze({CPU: 'cpu', MEMORY: 'memory'});

// The score of an entry is cpuShare * cpuWeight + memoryShare * memoryWeight, where the
// shares are fractions of the whole machine and the weights say how scarce the resource is.
//
// CPU time always costs something (power, heat, fan), so its weight starts at 1 and grows
// with the CPU pressure the kernel reports. Memory is different: memory that is in use slows
// nothing down as long as there is plenty left. Its weight is therefore 0 while less than
// this fraction of the memory is in use, and rises linearly to 1 when all of it is.
export const MEMORY_SCARCE_FROM = 0.6;

// Memory pressure ("some avg10" in /proc/pressure/memory, a percentage of time in which tasks
// waited for memory) at which memory counts as fully scarce, however much looks available.
const MEMORY_PRESSURE_FULL = 10;

// The CPU share of an entry is its mean over this many samples, so that a short burst does
// not take the lead.
const CPU_SAMPLES = 3;

// A challenger has to beat the leader's score by this factor to replace it; two entries that
// are close do not swap places on every sample.
const LEADER_MARGIN = 1.15;

const USAGE_USEC = /^usage_usec\s+(\d+)/m;
const ANON = /^anon\s+(\d+)/m;
const SHMEM = /^shmem\s+(\d+)/m;
const MEM_TOTAL = /^MemTotal:\s+(\d+)/m;
const MEM_AVAILABLE = /^MemAvailable:\s+(\d+)/m;
const PRESSURE_SOME = /^some avg10=([\d.]+)/m;

function number(pattern, text) {
    const match = pattern.exec(text ?? '');
    return match ? Number(match[1]) : null;
}

function unescapeUnitName(text) {
    return text.replace(/\\x([0-9a-f]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function lastComponent(id) {
    return id.split('.').at(-1);
}

// Turns the name of a cgroup directory into {key, appId, label}, or null for directories that
// are not applications or services. Entries with the same key are added up, because desktop
// environments start one application in more than one scope; a null key means the entry
// stands for itself.
//
// systemd names application cgroups app[-<launcher>]-<id>-<random>.scope,
// app[-<launcher>]-<id>[@<random>].service or app[-<launcher>]-<id>.slice. Dashes inside the
// parts are escaped as \x2d, so the plain dashes are the separators.
export function parseUnit(name) {
    let match = /^app-(.+)\.(scope|service|slice)$/.exec(name);
    if (match) {
        const parts = match[1].split('-');
        if (match[2] === 'scope' && parts.length > 1)
            parts.pop();
        const id = unescapeUnitName(parts.at(-1).replace(/@.*$/, ''));
        return {key: `app:${id}`, appId: id, label: lastComponent(id)};
    }

    match = /^snap\.([^.]+)\..*\.(scope|service)$/.exec(name);
    if (match)
        return {key: `app:${match[1]}`, appId: match[1], label: match[1]};

    match = /^docker-([0-9a-f]{6})[0-9a-f]*\.scope$/.exec(name);
    if (match)
        return {key: null, appId: null, label: `docker ${match[1]}`};

    match = /^session-(\d+)\.scope$/.exec(name);
    if (match)
        return {key: null, appId: null, label: `session ${match[1]}`};

    if (name === 'init.scope')
        return {key: null, appId: null, label: 'systemd'};

    match = /^(.+?)(?:@.*)?\.(service|scope)$/.exec(name);
    if (match) {
        const id = unescapeUnitName(match[1]);
        return {key: null, appId: id, label: lastComponent(id)};
    }

    return null;
}

// A slice groups units and is walked into, and so is the service that holds a user's own
// systemd instance. An application slice is the exception: it is the application.
function isContainer(name) {
    return (name.endsWith('.slice') && !/^app-.+\.slice$/.test(name)) || /^user@\d+\.service$/.test(name);
}

export function memoryWeight(usedFraction, memoryPressure) {
    const fromUse = (usedFraction - MEMORY_SCARCE_FROM) / (1 - MEMORY_SCARCE_FROM);
    const fromPressure = memoryPressure / MEMORY_PRESSURE_FULL;
    return Math.min(1, Math.max(0, fromUse, fromPressure));
}

// What TopMonitor reads the machine through. Exported so tools and tests can replace it.
export const systemIo = Object.freeze({readText, listNames});

// Times passed to the methods are monotonic and in seconds.
export class TopMonitor {
    #io;
    #cpuCount;
    #lastTime = null;
    #lastUsage = new Map();
    #cpuHistory = new Map();
    #leaderKey = null;

    constructor(io = systemIo, cpuCount = GLib.get_num_processors()) {
        this.#io = io;
        this.#cpuCount = cpuCount;
    }

    // Resolves to {leader, ranking}. ranking holds every application and service, heaviest
    // first, as {key, appId, label, cpuShare, memoryBytes, score, reason}; leader is the
    // entry to show, or null while there is nothing to rank. memoryBytes is only filled in
    // for the leader and the first detailRows entries unless memory is scarce: while it does
    // not count, reading it for everything would double the cost of a sample. The first call
    // only takes the CPU counters and ranks nothing. Meant to be called every few seconds.
    async sample(now, cancellable = null, detailRows = 5) {
        const units = await this.#readUnits(cancellable);
        const system = await this.#readSystem(cancellable);
        if (system.memoryWeight > 0)
            await this.#readMemory([...units.values()], cancellable);

        const elapsed = this.#lastTime === null ? null : now - this.#lastTime;
        this.#lastTime = now;

        const ranking = [];
        const history = new Map();
        for (const [key, unit] of units) {
            const shares = this.#cpuHistory.get(key) ?? [];
            const before = this.#lastUsage.get(key);
            if (elapsed > 0 && before !== undefined) {
                const used = Math.max(0, unit.usageUsec - before);
                shares.push(used / (elapsed * 1e6 * this.#cpuCount));
            }
            const recent = shares.slice(-CPU_SAMPLES);
            history.set(key, recent);

            const cpuShare = recent.length > 0
                ? recent.reduce((sum, share) => sum + share, 0) / recent.length
                : 0;
            const cpuScore = cpuShare * system.cpuWeight;
            const memoryScore = system.memoryTotal > 0
                ? (unit.memoryBytes ?? 0) / system.memoryTotal * system.memoryWeight
                : 0;
            ranking.push({
                key,
                appId: unit.appId,
                label: unit.label,
                cpuShare,
                memoryBytes: unit.memoryBytes,
                score: cpuScore + memoryScore,
                reason: memoryScore > cpuScore ? Reason.MEMORY : Reason.CPU,
            });
        }
        this.#lastUsage = new Map([...units].map(([key, unit]) => [key, unit.usageUsec]));
        this.#cpuHistory = history;

        if (elapsed === null)
            return {leader: null, ranking: []};

        ranking.sort((a, b) => b.score - a.score);
        const leader = this.#chooseLeader(ranking);

        const shown = new Set(ranking.slice(0, detailRows));
        if (leader)
            shown.add(leader);
        const unread = [...shown].filter(entry => entry.memoryBytes === null);
        await this.#readMemory(unread.map(entry => units.get(entry.key)), cancellable);
        for (const entry of unread)
            entry.memoryBytes = units.get(entry.key).memoryBytes;

        return {leader, ranking};
    }

    #chooseLeader(ranking) {
        const [challenger] = ranking;
        const leader = ranking.find(entry => entry.key === this.#leaderKey);
        const chosen = leader && challenger.score <= leader.score * LEADER_MARGIN
            ? leader
            : challenger;
        this.#leaderKey = chosen?.key ?? null;
        return chosen ?? null;
    }

    // Resolves to a map from key to {appId, label, paths, usageUsec, memoryBytes}, with the
    // memory still unread.
    async #readUnits(cancellable) {
        const units = new Map();
        for (const {path, info} of await this.#findUnits(CGROUP_ROOT, cancellable)) {
            const usageUsec = number(USAGE_USEC, await this.#io.readText(`${path}/cpu.stat`, cancellable));
            // A cgroup that disappeared while it was being read.
            if (usageUsec === null)
                continue;

            const key = info.key ?? path;
            const unit = units.get(key) ??
                {appId: info.appId, label: info.label, paths: [], usageUsec: 0, memoryBytes: null};
            unit.paths.push(path);
            unit.usageUsec += usageUsec;
            units.set(key, unit);
        }
        return units;
    }

    // Anonymous and shared memory is what cannot be given back without swapping. The page
    // cache a cgroup is charged for is left out: it is reclaimed on demand, and counting it
    // would blame whatever reads many files.
    async #readMemory(units, cancellable) {
        for (const unit of units) {
            unit.memoryBytes = 0;
            for (const path of unit.paths) {
                const stat = await this.#io.readText(`${path}/memory.stat`, cancellable);
                unit.memoryBytes += (number(ANON, stat) ?? 0) + (number(SHMEM, stat) ?? 0);
            }
        }
    }

    async #findUnits(directory, cancellable) {
        const found = [];
        for (const name of await this.#io.listNames(directory, cancellable)) {
            const path = `${directory}/${name}`;
            if (isContainer(name)) {
                found.push(...await this.#findUnits(path, cancellable));
                continue;
            }
            const info = parseUnit(name);
            if (info)
                found.push({path, info});
        }
        return found;
    }

    // Kernels without pressure stall information have no pressure files; that reads as none.
    async #readSystem(cancellable) {
        const [meminfo, cpuPressure, memoryPressure] = await Promise.all([
            this.#io.readText(MEMINFO_PATH, cancellable),
            this.#io.readText(CPU_PRESSURE_PATH, cancellable),
            this.#io.readText(MEMORY_PRESSURE_PATH, cancellable),
        ]);
        const totalKb = number(MEM_TOTAL, meminfo) ?? 0;
        const availableKb = number(MEM_AVAILABLE, meminfo) ?? totalKb;
        const usedFraction = totalKb > 0 ? 1 - availableKb / totalKb : 0;
        return {
            memoryTotal: totalKb * 1024,
            cpuWeight: 1 + (number(PRESSURE_SOME, cpuPressure) ?? 0) / 100,
            memoryWeight: memoryWeight(usedFraction, number(PRESSURE_SOME, memoryPressure) ?? 0),
        };
    }
}
