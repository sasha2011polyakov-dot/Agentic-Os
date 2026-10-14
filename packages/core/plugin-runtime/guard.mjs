// Loaded with --import before any extension code (section 30). Together with Node's permission model
// (--permission: no file writes, file reads only inside the extension folder, no child processes, no workers,
// no native addons, no process.binding) it removes direct network access and loader tampering: the extension
// talks to the outside world ONLY through the host API, which checks the permissions the user granted.
import module from 'node:module';

const DENY = new Set(['net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'child_process', 'worker_threads', 'cluster', 'inspector', 'vm', 'repl', 'module', 'sqlite', 'v8', 'wasi', 'trace_events']);
const bare = (s) => String(s).replace(/^node:/, '').split('/')[0];
const denied = (what) => {
  const e = new Error(`The module "${what}" is not available to extensions: use the application API.`);
  e.code = 'ERR_ACCESS_DENIED';
  return e;
};

module.registerHooks({
  resolve(specifier, context, next) {
    if (DENY.has(bare(specifier)) && (String(specifier).startsWith('node:') || module.isBuiltin(specifier))) throw denied(specifier);
    return next(specifier, context);
  },
});

const original = process.getBuiltinModule?.bind(process);
Object.defineProperty(process, 'getBuiltinModule', {
  value: (id) => {
    if (DENY.has(bare(id))) throw denied(id);
    return original(id);
  },
  configurable: false,
  writable: false,
});

for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try {
    Object.defineProperty(globalThis, k, { value: undefined, configurable: false, writable: false });
  } catch {
    // already absent
  }
}
