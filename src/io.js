// SPDX-License-Identifier: GPL-2.0-or-later
// Asynchronous file and process helpers shared by the modules that do not depend on GNOME
// Shell. Nothing here blocks the main loop.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const ENUMERATE_BATCH = 64;
const COMMAND_TIMEOUT_SECONDS = 5;

export function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// The files read here (sysfs, procfs, cgroupfs) come and go with the state of the machine; an
// unreadable one is reported as null. Cancellation is propagated so callers can stop.
export async function readText(path, cancellable = null) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return new TextDecoder().decode(bytes);
    } catch (error) {
        if (isCancelled(error))
            throw error;
        return null;
    }
}

// The names in a directory; empty when it cannot be listed.
export async function listNames(path, cancellable = null) {
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
    } catch (error) {
        if (isCancelled(error))
            throw error;
        return [];
    }
    const names = [];
    try {
        for (;;) {
            const batch = await enumerator.next_files_async(ENUMERATE_BATCH, GLib.PRIORITY_DEFAULT, cancellable);
            if (batch.length === 0)
                break;
            names.push(...batch.map(info => info.get_name()));
        }
    } catch (error) {
        if (isCancelled(error))
            throw error;
    } finally {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    return names;
}

// Resolves to stdout, or to null when the command cannot be started, fails or hangs.
export async function runCommand(argv, cancellable = null) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch {
        return null;
    }
    const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;
    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COMMAND_TIMEOUT_SECONDS, () => {
        timeoutId = 0;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout] = await proc.communicate_utf8_async(null, cancellable);
        return proc.get_successful() ? stdout : null;
    } catch (error) {
        if (isCancelled(error))
            throw error;
        return null;
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}
