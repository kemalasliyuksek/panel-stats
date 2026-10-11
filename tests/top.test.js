// SPDX-License-Identifier: GPL-2.0-or-later
// Tests for src/top.js, against a fake cgroup tree and fake /proc files.
import {assertEquals, test} from './harness.js';

import {MEMORY_SCARCE_FROM, Reason, TopMonitor, memoryWeight, parseUnit} from '../src/top.js';

const ROOT = '/sys/fs/cgroup';
const APPS = 'user.slice/user-1000.slice/user@1000.service/app.slice';
const CPUS = 10;
const INTERVAL = 3;
const MEM_TOTAL_KB = 32_000_000;
const MEM_TOTAL = MEM_TOTAL_KB * 1024;

// A fake machine. state.units maps a cgroup path below the root to {usage, anon, shmem};
// tests change state between samples.
function machine(units, {availableFraction = 0.75, memoryPressure = 0, cpuPressure = 0} = {}) {
    const state = {units, availableFraction, memoryPressure, cpuPressure};
    const reads = [];
    const pressure = value => `some avg10=${value.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`;
    const io = {
        listNames: path => {
            const prefix = path === ROOT ? '' : `${path.slice(ROOT.length + 1)}/`;
            const names = new Set();
            for (const unitPath of Object.keys(state.units)) {
                if (unitPath.startsWith(prefix))
                    names.add(unitPath.slice(prefix.length).split('/')[0]);
            }
            return Promise.resolve([...names]);
        },
        readText: path => {
            reads.push(path);
            if (path === '/proc/meminfo') {
                return Promise.resolve(`MemTotal:       ${MEM_TOTAL_KB} kB\nMemFree:        1 kB\n` +
                    `MemAvailable:   ${Math.round(MEM_TOTAL_KB * state.availableFraction)} kB\n`);
            }
            if (path === '/proc/pressure/memory')
                return Promise.resolve(pressure(state.memoryPressure));
            if (path === '/proc/pressure/cpu')
                return Promise.resolve(pressure(state.cpuPressure));
            const match = /^\/sys\/fs\/cgroup\/(.+)\/(cpu\.stat|memory\.stat)$/.exec(path);
            const unit = match && state.units[match[1]];
            if (!unit)
                return Promise.resolve(null);
            return Promise.resolve(match[2] === 'cpu.stat'
                ? `usage_usec ${unit.usage}\nuser_usec 1\nsystem_usec 1\n`
                : `anon ${unit.anon ?? 0}\nfile 999999999\nkernel 5\nshmem ${unit.shmem ?? 0}\ninactive_file 7\n`);
        },
    };
    return {state, io, reads, monitor: new TopMonitor(io, CPUS)};
}

// Lets every unit use the given share of the machine's CPU for one interval and samples.
async function step(fake, time, shares) {
    for (const [path, share] of Object.entries(shares))
        fake.state.units[path].usage += Math.round(share * INTERVAL * 1e6 * CPUS);
    return fake.monitor.sample(time * INTERVAL);
}

function percent(share) {
    return Math.round(share * 1000) / 10;
}

test('parseUnit reads application scopes with and without a launcher', () => {
    assertEquals(parseUnit('app-gnome-firefox-84624.scope'),
        {key: 'app:firefox', appId: 'firefox', label: 'firefox'}, 'launcher');
    assertEquals(parseUnit('app-com.onepassword.OnePassword-78910.scope'),
        {key: 'app:com.onepassword.OnePassword', appId: 'com.onepassword.OnePassword', label: 'OnePassword'}, 'no launcher');
    assertEquals(parseUnit('app-flatpak-org.mozilla.firefox-1234.scope').appId, 'org.mozilla.firefox', 'flatpak');
});

test('parseUnit unescapes dashes in application ids', () => {
    assertEquals(parseUnit('app-gnome-org.gnome.Evolution\\x2dalarm\\x2dnotify-78947.scope').appId,
        'org.gnome.Evolution-alarm-notify', 'scope');
    assertEquals(parseUnit('app-gnome\\x2dsession\\x2dmanager@ubuntu.service').appId,
        'gnome-session-manager', 'service');
});

test('parseUnit reads application slices, snaps, services and the special scopes', () => {
    assertEquals(parseUnit('app-org.gnome.Terminal.slice').key, 'app:org.gnome.Terminal', 'slice');
    assertEquals(parseUnit('snap.firefox.firefox-7b1c2e0a-1111-2222-3333-444455556666.scope').label, 'firefox', 'snap');
    assertEquals(parseUnit('docker.service'), {key: null, appId: 'docker', label: 'docker'}, 'service');
    assertEquals(parseUnit('org.gnome.Shell@ubuntu.service'),
        {key: null, appId: 'org.gnome.Shell', label: 'Shell'}, 'template service');
    assertEquals(parseUnit('docker-0123456789abcdef0123456789abcdef.scope').label, 'docker 012345', 'container');
    assertEquals(parseUnit('session-12.scope').label, 'session 12', 'session');
    assertEquals(parseUnit('init.scope').label, 'systemd', 'init');
});

test('parseUnit ignores what is neither an application nor a service', () => {
    for (const name of ['cpu.stat', 'dev-hugepages.mount', 'system.slice', 'cgroup.procs'])
        assertEquals(parseUnit(name), null, name);
});

test('memory has no weight until it gets scarce and full weight when it is used up', () => {
    assertEquals(memoryWeight(0.3, 0), 0, 'plenty free');
    assertEquals(memoryWeight(MEMORY_SCARCE_FROM, 0), 0, 'at the threshold');
    assertEquals(percent(memoryWeight(0.8, 0)), 50, 'half way');
    assertEquals(memoryWeight(1, 0), 1, 'used up');
});

test('memory pressure makes memory count however much looks available', () => {
    assertEquals(memoryWeight(0.3, 5), 0.5, 'some pressure');
    assertEquals(memoryWeight(0.3, 50), 1, 'heavy pressure');
});

test('the first sample ranks nothing', async () => {
    const fake = machine({'system.slice/docker.service': {usage: 5_000_000}});
    assertEquals(await fake.monitor.sample(0), {leader: null, ranking: []}, 'first sample');
});

test('a machine without cgroups has nothing to rank', async () => {
    const fake = machine({});
    await fake.monitor.sample(0);
    assertEquals(await fake.monitor.sample(INTERVAL), {leader: null, ranking: []}, 'second sample');
});

test('the CPU share is the fraction of the whole machine used since the last sample', async () => {
    const fake = machine({'system.slice/docker.service': {usage: 123}});
    await fake.monitor.sample(0);
    const {leader} = await step(fake, 1, {'system.slice/docker.service': 0.25});
    assertEquals([leader.label, percent(leader.cpuShare), leader.reason], ['docker', 25, Reason.CPU], 'leader');
});

test('with memory nearly used up, the program holding most of it outweighs a busier one', async () => {
    const [a, b] = [`${APPS}/app-gnome-hoarder-1.scope`, `${APPS}/app-gnome-worker-2.scope`];
    const fake = machine({
        [a]: {usage: 0, anon: 0.8 * MEM_TOTAL},
        [b]: {usage: 0, anon: 0.1 * MEM_TOTAL},
    }, {availableFraction: 0.05});
    await fake.monitor.sample(0);
    const {leader} = await step(fake, 1, {[a]: 0.02, [b]: 0.2});
    assertEquals([leader.label, leader.reason], ['hoarder', Reason.MEMORY], 'leader');
});

test('with plenty of memory left, the busier program outweighs the one holding more memory', async () => {
    const [a, b] = [`${APPS}/app-gnome-hoarder-1.scope`, `${APPS}/app-gnome-worker-2.scope`];
    const fake = machine({
        [a]: {usage: 0, anon: 0.3 * MEM_TOTAL},
        [b]: {usage: 0, anon: 0.1 * MEM_TOTAL},
    }, {availableFraction: 0.55});
    await fake.monitor.sample(0);
    const {leader, ranking} = await step(fake, 1, {[a]: 0.02, [b]: 0.2});
    assertEquals([leader.label, leader.reason], ['worker', Reason.CPU], 'leader');
    assertEquals(ranking.map(entry => entry.label), ['worker', 'hoarder'], 'ranking');
});

test('the scopes of one application are added up', async () => {
    const [first, second] = [`${APPS}/app-gnome-com.example.App-7.scope`, `${APPS}/app-com.example.App-7.scope`];
    const fake = machine({
        [first]: {usage: 0, anon: 1000, shmem: 10},
        [second]: {usage: 0, anon: 2000, shmem: 20},
    });
    await fake.monitor.sample(0);
    const {ranking} = await step(fake, 1, {[first]: 0.1, [second]: 0.05});
    assertEquals(ranking.length, 1, 'entries');
    assertEquals([ranking[0].appId, percent(ranking[0].cpuShare), ranking[0].memoryBytes],
        ['com.example.App', 15, 3030], 'entry');
});

test('the page cache a cgroup is charged for does not count as its memory', async () => {
    const path = 'system.slice/reader.service';
    const fake = machine({[path]: {usage: 0, anon: 4096, shmem: 0}});
    await fake.monitor.sample(0);
    const {leader} = await step(fake, 1, {[path]: 0.1});
    assertEquals(leader.memoryBytes, 4096, 'memory');
});

test('while memory does not count it is only read for the entries that get shown', async () => {
    const units = {};
    for (let i = 0; i < 8; i++)
        units[`system.slice/unit${i}.service`] = {usage: 0, anon: 1000};
    const fake = machine(units);
    await fake.monitor.sample(0);
    fake.reads.length = 0;
    const {ranking} = await fake.monitor.sample(INTERVAL, null, 3);
    assertEquals(fake.reads.filter(path => path.endsWith('memory.stat')).length, 3, 'memory.stat reads');
    assertEquals(ranking.map(entry => entry.memoryBytes), [1000, 1000, 1000, null, null, null, null, null], 'memory');
});

test('once memory is scarce it is read for every entry', async () => {
    const units = {};
    for (let i = 0; i < 8; i++)
        units[`system.slice/unit${i}.service`] = {usage: 0, anon: 1000};
    const fake = machine(units, {availableFraction: 0.1});
    await fake.monitor.sample(0);
    fake.reads.length = 0;
    await fake.monitor.sample(INTERVAL, null, 3);
    assertEquals(fake.reads.filter(path => path.endsWith('memory.stat')).length, 8, 'memory.stat reads');
});

test('the CPU share is the mean of the last three samples', async () => {
    const path = 'system.slice/bursty.service';
    const fake = machine({[path]: {usage: 0}});
    await fake.monitor.sample(0);
    await step(fake, 1, {[path]: 0});
    await step(fake, 2, {[path]: 0});
    const {leader} = await step(fake, 3, {[path]: 0.9});
    assertEquals(percent(leader.cpuShare), 30, 'after one burst');
});

test('a challenger that is only slightly ahead does not replace the leader', async () => {
    const [x, y] = ['system.slice/x.service', 'system.slice/y.service'];
    const fake = machine({[x]: {usage: 0}, [y]: {usage: 0}});
    await fake.monitor.sample(0);
    let result;
    for (let time = 1; time <= 3; time++)
        result = await step(fake, time, {[x]: 0.10, [y]: 0.05});
    assertEquals(result.leader.label, 'x', 'first leader');

    for (let time = 4; time <= 6; time++)
        result = await step(fake, time, {[x]: 0.10, [y]: 0.11});
    assertEquals([result.ranking[0].label, result.leader.label], ['y', 'x'], 'slightly ahead');

    for (let time = 7; time <= 9; time++)
        result = await step(fake, time, {[x]: 0.10, [y]: 0.20});
    assertEquals(result.leader.label, 'y', 'clearly ahead');
});

test('units that come and go between samples are handled', async () => {
    const [stays, goes, comes] = ['system.slice/stays.service', 'system.slice/goes.service', 'system.slice/comes.service'];
    const fake = machine({[stays]: {usage: 0}, [goes]: {usage: 0}});
    await fake.monitor.sample(0);
    delete fake.state.units[goes];
    fake.state.units[comes] = {usage: 9_000_000};
    const {ranking} = await step(fake, 1, {[stays]: 0.1});
    assertEquals(ranking.map(entry => [entry.label, percent(entry.cpuShare)]), [['stays', 10], ['comes', 0]], 'ranking');
});

test('CPU pressure raises the weight of CPU time', async () => {
    const path = 'system.slice/busy.service';
    const calm = machine({[path]: {usage: 0}});
    const pressed = machine({[path]: {usage: 0}}, {cpuPressure: 50});
    await calm.monitor.sample(0);
    await pressed.monitor.sample(0);
    const calmScore = (await step(calm, 1, {[path]: 0.4})).leader.score;
    const pressedScore = (await step(pressed, 1, {[path]: 0.4})).leader.score;
    assertEquals([percent(calmScore), percent(pressedScore)], [40, 60], 'scores');
});
