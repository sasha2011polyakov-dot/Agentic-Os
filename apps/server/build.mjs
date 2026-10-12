// Bundles the server + core into a single ESM file runnable with plain `node` (no TS loader needed).
import { build } from 'esbuild';
import { chmodSync, cpSync, rmSync, writeFileSync } from 'node:fs';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/aos-main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // node:* builtins (incl. node:sqlite) stay external automatically; CJS deps need require() in ESM output:
  banner: { js: "import { createRequire as __aosCreateRequire } from 'node:module';\nconst require = __aosCreateRequire(import.meta.url);" },
  logLevel: 'info',
});

// Library entry used by the Electron shell (no CLI side effects).
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  banner: { js: "import { createRequire as __aosCreateRequire } from 'node:module';\nconst require = __aosCreateRequire(import.meta.url);" },
  logLevel: 'info',
});

// Built-in agent packages are data (no code) and ship next to the bundle: dist/agents-builtin.
rmSync('dist/agents-builtin', { recursive: true, force: true });
cpSync('../../packages/core/agents-builtin', 'dist/agents-builtin', { recursive: true });

// CLI wrapper: installs the warning filter BEFORE the bundle (and node:sqlite) is loaded — static ESM imports
// would otherwise be evaluated before any code in the bundle could filter the ExperimentalWarning.
writeFileSync(
  'dist/aos.mjs',
  `#!/usr/bin/env node
const emit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (text.includes('SQLite is an experimental feature')) return;
  return emit(warning, ...rest);
};
await import('./aos-main.mjs');
`,
);
chmodSync('dist/aos.mjs', 0o755);
