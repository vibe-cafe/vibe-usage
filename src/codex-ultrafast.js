import { chooseCutStartAt } from './cut-start.js';

// Codex Ultrafast attribution (approved 2026-11-18, see AGENTS.md).
//
// Codex usage served at the Ultrafast tier is priced at six times the standard
// rate, so it has to reach the server as its own `<model>-ultrafast` bucket.
// Renaming is not free: a bucket's key contains the model name and the server
// never shrinks a stored bucket. A half hour already uploaded as `<model>` = 100
// (60 standard + 40 Ultrafast folded together, which is what every release
// before this one sends) would keep its 100 and gain a second bucket of 40.
//
// So each machine has one cut. Windows before it keep the merged format for
// good; windows at or after it are split. The cut lives on the server, keyed by
// account and upload hostname, and nowhere on this machine: `config.json` and
// `state.json` can both be deleted by the desktop apps' "reset configuration",
// and a cut that moved would count the same tokens twice. Every sync reads it
// with the settings request, declares it on every upload, and the server
// refuses Codex windows whose format disagrees with the registered cut -- which
// is also what stops an older collector on the same machine from folding a
// split window back together.

/** The cut meaning "all local history". */
export const CODEX_ULTRAFAST_ALL_HISTORY = '1970-01-01T00:00:00.000Z';
export const CODEX_ULTRAFAST_SUFFIX = '-ultrafast';
const CODEX_SOURCES = new Set(['codex']);

export const CODEX_ULTRAFAST_HOLD_WARNING =
  'codex: 服务端暂时没有答复这台设备的 Ultrafast 档位起点，本次不上传 Codex（其他工具照常），下次同步自动补传';
/** The sync's closing failure line when Codex was held (see runSync). */
export const CODEX_ULTRAFAST_HOLD_FAILURE =
  'Codex 本次未上传：服务端暂时没有答复这台设备的 Ultrafast 档位起点，其他工具已正常同步，下次同步自动补传。';

/**
 * A cut as epoch milliseconds; `null` when the machine has none. Anything that
 * is not a UTC ISO-8601 instant throws: guessing a cut would pick a format the
 * server then has to refuse.
 */
export function codexUltrafastStartMs(value) {
  if (value === undefined || value === null) return null;
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Codex Ultrafast 起点不是有效的 UTC 时间');
  return ms;
}

/** The uploaded model name for Ultrafast usage in the window starting at `bucketStart`. */
export function codexUltrafastModel(model, bucketStart, startMs) {
  return startMs !== null && Date.parse(bucketStart) >= startMs ? `${model}${CODEX_ULTRAFAST_SUFFIX}` : model;
}

/**
 * The cut this machine proposes when none is registered yet, or `undefined`
 * when this run may not register one. Same rule as the Magpie cut
 * (`chooseCutStartAt`); the server additionally floors it at the end of the
 * latest Codex window it already holds for this machine, so a proposal made
 * from lost or empty local state cannot land inside uploaded history.
 */
export function proposeCodexUltrafastStart(state, { daemonInstalled, surface, now }) {
  const startAt = chooseCutStartAt(state, CODEX_SOURCES, { daemonInstalled, surface, now });
  return startAt === 'none' ? CODEX_ULTRAFAST_ALL_HISTORY : startAt;
}

/**
 * Decide the Codex format for one sync.
 *
 * Returns `{ hold: true }` when the server gave no answer about this machine's
 * cut -- the settings request fell back to a cached value, or the server does
 * not report the cut at all (not deployed yet, or rolled back). Codex is then
 * skipped for this run rather than uploaded in a guessed format: a pause heals
 * on the next sync, a merged upload over split buckets cannot be undone.
 *
 * Otherwise `{ startAt }`: the registered cut, or `null` when there is none and
 * this run could not register one (not eligible, or the request failed) --
 * every window is then uploaded in the merged format, as before.
 *
 * @param {object} options
 * @param {object|null} options.settings the settings response of this sync, null if unconfirmed
 * @param {() => string|undefined} options.propose this machine's proposal (see above)
 * @param {(proposedStartAt: string) => Promise<{startAt?: string}>} options.register
 */
export async function resolveCodexUltrafastCut({ settings, propose, register }) {
  const reported = settings?.codexUltrafast;
  if (!reported || typeof reported !== 'object' || !Object.hasOwn(reported, 'startAt')) return { hold: true };
  try {
    if (reported.startAt !== null) {
      codexUltrafastStartMs(reported.startAt);
      return { startAt: reported.startAt };
    }
    const proposedStartAt = propose();
    if (proposedStartAt === undefined) return { startAt: null };
    let registered;
    try {
      registered = await register(proposedStartAt);
    } catch {
      // Not registered as far as this run knows. If the request did land, the
      // server refuses this run's post-cut Codex windows and the next sync
      // reads the cut.
      return { startAt: null };
    }
    if (codexUltrafastStartMs(registered?.startAt) === null) return { startAt: null };
    return { startAt: registered.startAt, registered: true };
  } catch {
    return { hold: true };
  }
}
