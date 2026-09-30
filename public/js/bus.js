/**
 * bus.js — tiny pub/sub so views can react to stream events without importing the
 * router (which would create an import cycle).
 */

const listeners = new Map();

export const EVENTS = {
  RUN_LOG: 'stream:run.log',
  RUN_STATUS: 'stream:run.status',
  STATS: 'stream:stats',
  HEALTH: 'stream:health',
  STREAM_MODE: 'stream:mode',
  NAVIGATE: 'app:navigate',
};

export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => off(type, handler);
}

export function off(type, handler) {
  const set = listeners.get(type);
  if (set) set.delete(handler);
}

export function emit(type, payload) {
  const set = listeners.get(type);
  if (!set || !set.size) return;
  for (const handler of Array.from(set)) {
    try {
      handler(payload);
    } catch (err) {
      // A listener must never break event delivery for the others.
      if (window.console && window.console.error) window.console.error('orbit bus handler failed', err);
    }
  }
}
