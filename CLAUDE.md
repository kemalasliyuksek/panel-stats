# panel-stats

GNOME Shell 50 extension: CPU, memory, swap, GPU and network usage in the top bar. A fork of
the System Monitor extension from gnome-shell-extensions 50.0 (GPL-2.0-or-later) with a GPU
section. Personal open source project, uuid `panel-stats@kemalasliyuksek.com`.

## Project rules that differ from the global defaults

- Everything in the repository is English: code, comments, README, commit messages. Commits
  use `/commit-en`.
- No AI trailer in commits. AI use is disclosed once, in the README.
- Commits are made only when Kemal asks, after he has seen a summary of the change.

## Layout

- `src/` is the extension root; it is what gets symlinked into
  `~/.local/share/gnome-shell/extensions/` and what `gnome-extensions pack` zips.
- `src/extension.js` is the upstream file plus our changes. Keep the diff against upstream
  small so a new GNOME release can be merged: do not reformat or restructure upstream code.
- `src/gpu.js` holds everything about GPUs and does not import anything from GNOME Shell,
  so it runs under plain gjs.
- `tests/run.js` are the unit tests for `gpu.js`, `tools/sample.js` runs it against the real
  hardware.

## Commands

`just --list` shows them. `just check` (syntax check and tests) has to pass before a commit.
There is no ESLint setup yet; `just lint` is a syntax check only.

## Things to know

- On Wayland GNOME Shell loads extension code at login. A code change is only visible after
  logging out and in again.
- Never start a second `gnome-shell` with an `XDG_RUNTIME_DIR` whose path is long: the
  Wayland socket path must stay under 108 bytes, otherwise the process aborts and apport
  reports a GNOME Shell crash to the user.
- Every `nvidia-smi` run wakes the NVIDIA card or keeps it awake. Do not add a code path that
  queries the card without checking `runtime_status` first, and measure with `just sample`
  after touching the sampling schedule.
- extensions.gnome.org reviews reject synchronous file IO in the Shell process. Use the
  asynchronous Gio calls.
