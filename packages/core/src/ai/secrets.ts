import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../util/errors.ts';
import { maskSecret, registerSecretValue, unregisterSecretValue } from '../util/redact.ts';
import { atomicWrite } from '../fs/safe-fs.ts';

export interface SecretBackend {
  id: string;
  label: string;
  persistent: boolean;
  writable: boolean;
  available(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  note?: string;
}

/** Adapter the Electron shell injects (wraps electron.safeStorage). */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  backendName(): string;
  encryptString(value: string): string; // base64
  decryptString(base64: string): string;
}

const SERVICE = 'agentic-os';

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', () => resolve({ code: 127, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    setTimeout(() => child.kill(), 15_000).unref();
  });
}

function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => execFile(platform() === 'win32' ? 'where' : 'which', [cmd], (err) => resolve(!err)));
}

/** Process-memory only; lost on restart. Always available. */
export class SessionBackend implements SecretBackend {
  id = 'session';
  label = 'This session only';
  persistent = false;
  writable = true;
  note = 'The key is kept in memory until the application restarts.';
  private readonly map = new Map<string, string>();
  async available() {
    return true;
  }
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

/** Read-only: AOS_SECRET_<KEY> environment variables (e.g. AOS_SECRET_OPENAI). */
export class EnvBackend implements SecretBackend {
  id = 'env';
  label = 'Environment variable';
  persistent = true;
  writable = false;
  note = 'Set the AOS_SECRET_<NAME> variable before starting the application.';
  constructor(private readonly env: NodeJS.ProcessEnv) {}
  static varName(key: string): string {
    return `AOS_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }
  async available() {
    return true;
  }
  async get(key: string) {
    return this.env[EnvBackend.varName(key)] ?? null;
  }
  async set() {
    throw new AppError('SECRET_STORE_UNAVAILABLE', 'Environment variables are set outside the application.');
  }
  async delete() {
    throw new AppError('SECRET_STORE_UNAVAILABLE', 'Environment variables are set outside the application.');
  }
}

/** macOS Keychain through /usr/bin/security. */
export class MacKeychainBackend implements SecretBackend {
  id = 'macos-keychain';
  label = 'macOS Keychain';
  persistent = true;
  writable = true;
  note = 'The value is passed to the security utility as a command-line argument while it is written.';
  async available() {
    return platform() === 'darwin' && (await which('security'));
  }
  async get(key: string) {
    const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : null;
  }
  async set(key: string, value: string) {
    const r = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', key, '-w', value]);
    if (r.code !== 0) throw new AppError('SECRET_STORE_UNAVAILABLE', `The keychain rejected the write: ${r.stderr.trim()}`);
  }
  async delete(key: string) {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', key]);
  }
}

/** Linux Secret Service (GNOME Keyring / KWallet) through secret-tool; the value goes through stdin. */
export class LinuxSecretServiceBackend implements SecretBackend {
  id = 'linux-secret-service';
  label = 'Secret Service (libsecret)';
  persistent = true;
  writable = true;
  async available() {
    if (platform() !== 'linux' || !(await which('secret-tool'))) return false;
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
    const probe = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', '__probe__']);
    return probe.code === 0 || probe.code === 1; // 1 = not found, but the service answered
  }
  async get(key: string) {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', key]);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : null;
  }
  async set(key: string, value: string) {
    const r = await run('secret-tool', ['store', `--label=Agentic OS: ${key}`, 'service', SERVICE, 'account', key], value);
    if (r.code !== 0) throw new AppError('SECRET_STORE_UNAVAILABLE', `Secret Service rejected the write: ${r.stderr.trim()}`);
  }
  async delete(key: string) {
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', key]);
  }
}

/** Electron safeStorage (Keychain / DPAPI / libsecret-backed key). Refuses the insecure "basic_text" backend. */
export class SafeStorageBackend implements SecretBackend {
  id = 'electron-safe-storage';
  label = 'OS secure storage (Electron safeStorage)';
  persistent = true;
  writable = true;
  constructor(
    private readonly adapter: SafeStorageAdapter,
    private readonly file: string,
  ) {}
  async available() {
    return this.adapter.isEncryptionAvailable() && this.adapter.backendName() !== 'basic_text';
  }
  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async get(key: string) {
    const data = await this.load();
    return data[key] ? this.adapter.decryptString(data[key]) : null;
  }
  async set(key: string, value: string) {
    const data = await this.load();
    data[key] = this.adapter.encryptString(value);
    await atomicWrite(this.file, JSON.stringify(data));
  }
  async delete(key: string) {
    const data = await this.load();
    delete data[key];
    await atomicWrite(this.file, JSON.stringify(data));
  }
}

/**
 * Secret references are "<backend>:<key>". The database only ever stores references — never values — so
 * backups, exports and logs cannot contain keys. Values are registered with the redactor on load.
 */
export class SecretStore {
  private readonly backends: SecretBackend[];
  private readonly cache = new Map<string, string>();

  constructor(env: NodeJS.ProcessEnv, dataDir: string, safeStorage?: SafeStorageAdapter) {
    this.backends = [
      ...(safeStorage ? [new SafeStorageBackend(safeStorage, join(dataDir, 'secrets.json'))] : []),
      new MacKeychainBackend(),
      new LinuxSecretServiceBackend(),
      new EnvBackend(env),
      new SessionBackend(),
    ];
  }

  async describe(): Promise<{ id: string; label: string; persistent: boolean; writable: boolean; available: boolean; note?: string }[]> {
    const out = [];
    for (const b of this.backends) out.push({ id: b.id, label: b.label, persistent: b.persistent, writable: b.writable, available: await b.available(), ...(b.note ? { note: b.note } : {}) });
    return out;
  }

  /** First available persistent writable backend, or null (then the UI offers env/session explicitly). */
  async defaultBackend(): Promise<SecretBackend | null> {
    for (const b of this.backends) if (b.persistent && b.writable && (await b.available())) return b;
    return null;
  }

  private backend(id: string): SecretBackend {
    const b = this.backends.find((x) => x.id === id);
    if (!b) throw new AppError('SECRET_STORE_UNAVAILABLE', `Unknown secret store: ${id}`);
    return b;
  }

  async put(key: string, value: string, backendId?: string): Promise<string> {
    if (!value || value.length < 8) throw new AppError('VALIDATION_FAILED', 'The key is too short.');
    const b = backendId ? this.backend(backendId) : await this.defaultBackend();
    if (!b) throw new AppError('SECRET_STORE_UNAVAILABLE');
    if (!(await b.available())) throw new AppError('SECRET_STORE_UNAVAILABLE', `${b.label} is not available on this computer.`);
    if (!b.writable) throw new AppError('SECRET_STORE_UNAVAILABLE', `${b.label}: the application cannot write to it.`);
    await b.set(key, value);
    const ref = `${b.id}:${key}`;
    this.cache.set(ref, value);
    registerSecretValue(value);
    return ref;
  }

  /** Reference to an env var secret (read-only backend) without storing anything. */
  envRef(key: string): string {
    return `env:${key}`;
  }

  async resolve(ref: string | null): Promise<string | null> {
    if (!ref) return null;
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const idx = ref.indexOf(':');
    if (idx <= 0) return null;
    const value = await this.backend(ref.slice(0, idx)).get(ref.slice(idx + 1));
    if (value) {
      this.cache.set(ref, value);
      registerSecretValue(value);
    }
    return value;
  }

  async remove(ref: string | null): Promise<void> {
    if (!ref) return;
    const idx = ref.indexOf(':');
    if (idx <= 0) return;
    const b = this.backend(ref.slice(0, idx));
    const cached = this.cache.get(ref);
    if (b.writable) await b.delete(ref.slice(idx + 1));
    this.cache.delete(ref);
    unregisterSecretValue(cached);
  }

  async masked(ref: string | null): Promise<{ present: boolean; masked: string | null; backend: string | null }> {
    if (!ref) return { present: false, masked: null, backend: null };
    const value = await this.resolve(ref).catch(() => null);
    return { present: !!value, masked: value ? maskSecret(value) : null, backend: ref.slice(0, ref.indexOf(':')) };
  }
}
