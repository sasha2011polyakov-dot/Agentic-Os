// Bundles the web interface into dist/: index.html + content-hashed assets (the server caches assets/ for a year).
// The page needs no inline script or style, so it works under the strict CSP of the local server.
import { context, build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: { app: 'src/main.tsx' },
  outdir: 'dist/assets',
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: ['chrome110', 'firefox115', 'safari16'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: true,
  metafile: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  logLevel: 'info',
};

function writeHtml(metafile) {
  const outputs = Object.keys(metafile.outputs).map((p) => basename(p));
  const js = outputs.find((f) => /^app-.*\.js$/.test(f));
  const css = outputs.find((f) => /^app-.*\.css$/.test(f));
  const html = readFileSync('index.html', 'utf8')
    .replace('<!--css-->', css ? `<link rel="stylesheet" href="/assets/${css}">` : '')
    .replace('<!--js-->', `<script type="module" src="/assets/${js}"></script>`);
  writeFileSync('dist/index.html', html);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/assets', { recursive: true });

if (watch) {
  const ctx = await context({ ...options, plugins: [{ name: 'html', setup: (b) => b.onEnd((r) => r.metafile && writeHtml(r.metafile)) }] });
  await ctx.watch();
} else {
  const result = await build(options);
  writeHtml(result.metafile);
}
