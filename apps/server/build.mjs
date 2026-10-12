// Bundles the server + core into a single ESM file runnable with plain `node` (no TS loader needed).
import { build } from 'esbuild';
import { chmodSync, writeFileSync } from 'node:fs';

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
