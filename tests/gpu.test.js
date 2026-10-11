// SPDX-License-Identifier: GPL-2.0-or-later
// Tests for src/gpu.js, against a fake sysfs and nvidia-smi.
import {assertEquals, test} from './harness.js';

import {
    DgpuSampleSchedule, GpuMonitor, IDLE_SAMPLE_GAP_SECONDS, IDLE_SETTLE_SECONDS,
    INTEGRATED_WINDOW_SECONDS, WAKE_WATCH_SECONDS, parsePercent,
} from '../src/gpu.js';

const STATUS_PATH = '/fake/nvidia/runtime_status';
const LOAD_PATH = '/fake/amd/gpu_busy_percent';
const GPUS = {
    nvidiaCards: [{address: '0000:01:00.0', statusPath: STATUS_PATH}],
    integratedLoadPath: LOAD_PATH,
};

// Stands in for sysfs and nvidia-smi. files maps a path to its content, or to a list of
// contents that successive reads return. nvidiaSmi is called for every nvidia-smi run and
// returns its stdout.
function fakeIo(files, nvidiaSmi = () => '0\n') {
    const commands = [];
    const reads = [];
    return {
        commands,
        reads,
        readText: path => {
            reads.push(path);
            const content = files[path];
            if (Array.isArray(content))
                return Promise.resolve(content.length > 1 ? content.shift() : content[0]);
            return Promise.resolve(content ?? null);
        },
        runCommand: argv => {
            commands.push(argv);
            return Promise.resolve(nvidiaSmi(argv));
        },
    };
}

// Samples once per second, like the panel does, and returns the seconds in which nvidia-smi ran.
async function secondsWithQuery(monitor, io, seconds, onTick = () => {}) {
    const queried = [];
    for (let now = 0; now < seconds; now++) {
        onTick(now);
        const before = io.commands.length;
        await monitor.sample(now);
        if (io.commands.length > before)
            queried.push(now);
    }
    return queried;
}

test('parsePercent reads a single percentage', () => {
    assertEquals(parsePercent('95\n'), 95, 'percent');
});

test('parsePercent takes the busiest of several cards', () => {
    assertEquals(parsePercent('12\n40\n7\n'), 40, 'percent');
});

test('parsePercent has no value for unreadable or unavailable input', () => {
    assertEquals(parsePercent(null), null, 'null');
    assertEquals(parsePercent(''), null, 'empty');
    assertEquals(parsePercent('[N/A]\n'), null, 'N/A');
});

test('schedule is due right after a wake-up', () => {
    assertEquals(new DgpuSampleSchedule().isDue(100), true, 'due');
});

test('schedule samples every tick while the card reports load', () => {
    const schedule = new DgpuSampleSchedule();
    for (let now = 0; now < 60; now++) {
        assertEquals(schedule.isDue(now), true, `due at ${now}`);
        schedule.record(0.5, now);
    }
});

test('schedule samples every tick right after a wake-up even without load', () => {
    const schedule = new DgpuSampleSchedule();
    for (let now = 0; now < WAKE_WATCH_SECONDS; now++) {
        assertEquals(schedule.isDue(now), true, `due at ${now}`);
        schedule.record(0, now);
    }
    assertEquals(schedule.isDue(WAKE_WATCH_SECONDS), false, 'after the wake watch');
});

test('schedule backs off once the card has been idle for the settle time', () => {
    const schedule = new DgpuSampleSchedule();
    const lastLoad = WAKE_WATCH_SECONDS + 30;
    schedule.record(0.5, 0);
    schedule.record(0.5, lastLoad);
    schedule.record(0, lastLoad + 1);
    assertEquals(schedule.isDue(lastLoad + IDLE_SETTLE_SECONDS - 1), true, 'still settling');
    schedule.record(0, lastLoad + IDLE_SETTLE_SECONDS - 1);
    assertEquals(schedule.isDue(lastLoad + IDLE_SETTLE_SECONDS), false, 'settled');
    assertEquals(schedule.isDue(lastLoad + IDLE_SETTLE_SECONDS - 1 + IDLE_SAMPLE_GAP_SECONDS), true, 'gap over');
});

test('schedule starts over after a reset', () => {
    const schedule = new DgpuSampleSchedule();
    schedule.record(0, 0);
    schedule.record(0, WAKE_WATCH_SECONDS);
    assertEquals(schedule.isDue(WAKE_WATCH_SECONDS + 1), false, 'backed off');
    schedule.reset();
    assertEquals(schedule.isDue(WAKE_WATCH_SECONDS + 1), true, 'after reset');
});

test('a suspended card is never queried and only the integrated GPU is reported', async () => {
    const io = fakeIo({[STATUS_PATH]: 'suspended\n', [LOAD_PATH]: '37\n'});
    const monitor = new GpuMonitor(GPUS, io);
    for (let now = 0; now < 120; now++) {
        assertEquals(await monitor.sample(now),
            {integratedLoad: 0.37, nvidiaAwake: false, nvidiaLoad: null}, `sample ${now}`);
    }
    assertEquals(io.commands.length, 0, 'nvidia-smi runs');
});

test('the integrated load is the mean of the readings in the window', async () => {
    const io = fakeIo({[STATUS_PATH]: 'suspended\n', [LOAD_PATH]: ['0\n', '100\n', '50\n', '50\n', '100\n']});
    const monitor = new GpuMonitor(GPUS, io);
    for (const now of [0.2, 0.4, 0.6, 0.8])
        await monitor.observe(now);
    assertEquals((await monitor.sample(1)).integratedLoad, 0.6, 'load');
});

test('readings older than the window do not count', async () => {
    const io = fakeIo({[STATUS_PATH]: 'suspended\n', [LOAD_PATH]: ['100\n', '20\n']});
    const monitor = new GpuMonitor(GPUS, io);
    await monitor.observe(0);
    assertEquals((await monitor.sample(INTEGRATED_WINDOW_SECONDS)).integratedLoad, 0.2, 'load');
});

test('the integrated GPU is reported next to an awake card', async () => {
    const io = fakeIo({[STATUS_PATH]: 'active\n', [LOAD_PATH]: '50\n'}, () => '64\n');
    assertEquals(await new GpuMonitor(GPUS, io).sample(0),
        {integratedLoad: 0.5, nvidiaAwake: true, nvidiaLoad: 0.64}, 'sample');
});

test('a machine without a readable integrated GPU reports no integrated load', async () => {
    const gpus = {nvidiaCards: GPUS.nvidiaCards, integratedLoadPath: null};
    const io = fakeIo({[STATUS_PATH]: 'suspended\n'});
    const monitor = new GpuMonitor(gpus, io);
    await monitor.observe(0);
    assertEquals(monitor.hasIntegratedLoad, false, 'hasIntegratedLoad');
    assertEquals((await monitor.sample(1)).integratedLoad, null, 'load');
    assertEquals(io.reads, [STATUS_PATH], 'files read');
});

test('a card that is suspending, resuming or unreadable is left alone', async () => {
    for (const status of ['suspending\n', 'resuming\n', 'error\n', undefined]) {
        const io = fakeIo({[STATUS_PATH]: status, [LOAD_PATH]: '5\n'});
        const sample = await new GpuMonitor(GPUS, io).sample(0);
        assertEquals(sample.nvidiaAwake, false, `awake for ${status}`);
        assertEquals(io.commands.length, 0, `nvidia-smi runs for ${status}`);
    }
});

test('an awake card is reported with the load nvidia-smi gives for it', async () => {
    const io = fakeIo({[STATUS_PATH]: 'active\n', [LOAD_PATH]: '5\n'}, () => '64\n');
    const sample = await new GpuMonitor(GPUS, io).sample(0);
    assertEquals([sample.nvidiaAwake, sample.nvidiaLoad], [true, 0.64], 'sample');
    assertEquals(io.commands[0], ['nvidia-smi', '--id=0000:01:00.0',
        '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], 'command');
});

test('a card without runtime power management is treated as awake', async () => {
    const io = fakeIo({[STATUS_PATH]: 'unsupported\n'}, () => '10\n');
    assertEquals((await new GpuMonitor(GPUS, io).sample(0)).nvidiaAwake, true, 'awake');
});

test('only the cards that are awake are queried', async () => {
    const gpus = {
        nvidiaCards: [
            {address: '0000:01:00.0', statusPath: '/fake/a'},
            {address: '0000:02:00.0', statusPath: '/fake/b'},
        ],
        integratedLoadPath: null,
    };
    const io = fakeIo({'/fake/a': 'suspended\n', '/fake/b': 'active\n'});
    await new GpuMonitor(gpus, io).sample(0);
    assertEquals(io.commands[0][1], '--id=0000:02:00.0', 'queried cards');
});

test('an awake but idle card is queried rarely enough to fall asleep', async () => {
    const io = fakeIo({[STATUS_PATH]: 'active\n'});
    const monitor = new GpuMonitor(GPUS, io);
    const queried = await secondsWithQuery(monitor, io, 60);
    assertEquals(queried, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 29, 49], 'seconds with a query');
});

test('a workload that starts a few seconds after the wake-up is seen at once', async () => {
    let load = '0\n';
    const io = fakeIo({[STATUS_PATH]: 'active\n'}, () => load);
    const monitor = new GpuMonitor(GPUS, io);
    for (let now = 0; now < 6; now++)
        assertEquals((await monitor.sample(now)).nvidiaLoad, 0, `load at ${now}`);
    load = '70\n';
    assertEquals((await monitor.sample(6)).nvidiaLoad, 0.7, 'load at 6');
});

test('the last known load is reported between queries of an idle card', async () => {
    const io = fakeIo({[STATUS_PATH]: 'active\n'});
    const monitor = new GpuMonitor(GPUS, io);
    for (let now = 0; now < 2 * WAKE_WATCH_SECONDS; now++)
        assertEquals((await monitor.sample(now)).nvidiaLoad, 0, `load at ${now}`);
});

test('a card under load is queried every second', async () => {
    const io = fakeIo({[STATUS_PATH]: 'active\n'}, () => '30\n');
    const monitor = new GpuMonitor(GPUS, io);
    assertEquals((await secondsWithQuery(monitor, io, 20)).length, 20, 'queries');
});

test('a card that wakes up again is queried at once', async () => {
    const files = {[STATUS_PATH]: 'active\n', [LOAD_PATH]: '5\n'};
    const io = fakeIo(files);
    const monitor = new GpuMonitor(GPUS, io);
    const queried = await secondsWithQuery(monitor, io, 12, now => {
        files[STATUS_PATH] = now >= 5 && now < 8 ? 'suspended\n' : 'active\n';
    });
    assertEquals(queried, [0, 1, 2, 3, 4, 8, 9, 10, 11], 'seconds with a query');
});

test('a failing nvidia-smi leaves the load without a value', async () => {
    const io = fakeIo({[STATUS_PATH]: 'active\n'}, () => null);
    const sample = await new GpuMonitor(GPUS, io).sample(0);
    assertEquals([sample.nvidiaAwake, sample.nvidiaLoad], [true, null], 'sample');
});

test('a machine without a readable GPU is not supported', () => {
    const none = new GpuMonitor({nvidiaCards: [], integratedLoadPath: null}, fakeIo({}));
    assertEquals(none.supported, false, 'no GPU');
    assertEquals(new GpuMonitor(GPUS, fakeIo({})).supported, true, 'hybrid');
});
