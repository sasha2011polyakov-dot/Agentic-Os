// Runs one tool of an extension in a restricted child process (see guard.mjs). Protocol: JSON lines on stdin/stdout.
//   host → plugin: {"type":"start","entry":"/abs/path/tools/x.mjs","input":{...}}
//   plugin → host: {"type":"call","id":1,"method":"documents.read","params":{...}}
//   host → plugin: {"type":"result","id":1,"ok":true,"value":...} | {"type":"result","id":1,"ok":false,"error":{...}}
//   plugin → host: {"type":"done","ok":true,"output":...} | {"type":"done","ok":false,"error":{...}}
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const pending = new Map();
let seq = 0;
let started = false;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

const call = (method, params) => {
  const id = ++seq;
  send({ type: 'call', id, method, params: params ?? {} });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

/** The whole API an extension has. Every call is checked by the host against the permissions granted right now. */
const api = Object.freeze({
  call,
  readDocument: (docId) => call('documents.read', { docId }),
  search: (query, limit) => call('search', { query, limit }),
  fetch: (url) => call('network.fetch', { url }),
  createDocument: (doc) => call('documents.create', doc),
  log: (message) => call('log', { message: String(message) }),
});

async function run(m) {
  try {
    const mod = await import(pathToFileURL(m.entry).href);
    const fn = mod.default ?? mod.run;
    if (typeof fn !== 'function') throw new Error('A tool module must export a default function: export default async (input, api) => …');
    const output = await fn(m.input ?? {}, api);
    send({ type: 'done', ok: true, output: output === undefined ? null : output });
  } catch (e) {
    send({ type: 'done', ok: false, error: { message: String(e?.message ?? e).slice(0, 2000), code: e?.code ?? null } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'start' && !started) {
    started = true;
    void run(m);
  } else if (m.type === 'result') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(Object.assign(new Error(m.error?.message ?? 'Denied'), { code: m.error?.code ?? 'PERMISSION_DENIED' }));
  }
});
