import { bucketKey } from './state.js';

export const MAGPIE_SOURCES = new Set(['claude-code', 'codex', 'pi-coding-agent', 'omp', 'opencode']);
export const HALF_HOUR_MS = 1_800_000;

export function magpieStartTime(value) {
  if (value === undefined) return null;
  if (value === 'none') return -Infinity;
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:(?:00|30):00(?:\.000)?Z$/.test(value)
    ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time < 0
    || new Date(time).toISOString() !== value.replace(/(?:\.000)?Z$/, '.000Z')) {
    throw new Error('magpieStartAt 必须是 UTC 半小时边界或 none，例如 2026-11-06T12:30:00Z');
  }
  return time;
}

function splitKey(key) {
  const parts = key.split('|');
  return { source: parts[0], model: parts[1], project: parts.slice(2, -2).join('|'),
    hostname: parts.at(-2), bucketStart: parts.at(-1) };
}

export function chooseMagpieStartAt(state, { daemonInstalled, surface, now = Date.now() }) {
  if (daemonInstalled && surface !== 'daemon') return undefined;
  if (state.identityChanged) return new Date((Math.floor(now / HALF_HOUR_MS) + 1) * HALF_HOUR_MS).toISOString();
  let latest = -Infinity;
  for (const key of Object.keys(state.buckets)) {
    const row = splitKey(key);
    if (MAGPIE_SOURCES.has(row.source)) latest = Math.max(latest, Date.parse(row.bucketStart) || -Infinity);
  }
  return Number.isFinite(latest) ? new Date(latest + HALF_HOUR_MS).toISOString() : 'none';
}

const coordinate = b => `${b.source}|${b.project}|${b.hostname}|${b.bucketStart}`;

// Apply after hostname/privacy mapping. Only whole token windows are withheld;
// session identities do not depend on model attribution.
export function planMagpieMigration(buckets, state, { startAt, failed = false, pending = [] } = {}) {
  const start = magpieStartTime(startAt);
  const current = new Map();
  const previous = new Map();
  for (const b of buckets) {
    if (!MAGPIE_SOURCES.has(b.source)) continue;
    const coord = coordinate(b);
    if (!current.has(coord)) current.set(coord, new Set());
    current.get(coord).add(bucketKey(b));
  }
  for (const key of Object.keys(state.buckets)) {
    const b = splitKey(key);
    if (!MAGPIE_SOURCES.has(b.source)) continue;
    const coord = coordinate(b);
    if (!previous.has(coord)) previous.set(coord, new Set());
    previous.get(coord).add(key);
  }
  const held = new Map();
  const isMagpie = key => splitKey(key).model?.startsWith('magpie/');
  for (const [coord, oldKeys] of previous) {
    const nextKeys = current.get(coord) || new Set();
    const missing = [...oldKeys].filter(key => !nextKeys.has(key));
    if (missing.some(isMagpie)
      || (missing.length && [...nextKeys].some(key => isMagpie(key) && !oldKeys.has(key)))) {
      held.set(coord, '模型归属发生翻转；请恢复本机账本、检查 XDG_CONFIG_HOME，并升级所有采集器后重启后台服务');
    }
  }
  for (const b of pending) held.set(coordinate(b), '最近 10 分钟的请求尚未与账本配对；请等待下次同步');
  if (failed && start !== null) {
    for (const coord of new Set([...current.keys(), ...previous.keys()])) {
      if (Date.parse(coord.slice(coord.lastIndexOf('|') + 1)) >= start) {
        held.set(coord, '本机账本读取失败；请检查账本路径和读取权限后重试');
      }
    }
  }
  const preserveBuckets = new Set();
  for (const coord of held.keys()) {
    for (const key of previous.get(coord) || []) preserveBuckets.add(key);
  }
  return {
    buckets: buckets.filter(b => !held.has(coordinate(b))),
    preserveBuckets,
    withheld: [...held].map(([window, reason]) => ({ window, reason })),
  };
}
