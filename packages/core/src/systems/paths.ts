import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Application data folder (registry, shared agents, backups, logs). Never contains system content. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AOS_DATA_DIR) return env.AOS_DATA_DIR;
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Agentic OS');
    case 'win32':
      return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Agentic OS');
    default:
      return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'agentic-os');
  }
}

export interface AppPaths {
  dataDir: string;
  registryDb: string;
  sharedAgentsDir: string;
  backupsDir: string;
  logsDir: string;
  logFile: string;
  tmpDir: string;
}

export function appPaths(dataDir: string): AppPaths {
  return {
    dataDir,
    registryDb: join(dataDir, 'registry.db'),
    sharedAgentsDir: join(dataDir, 'agents'),
    backupsDir: join(dataDir, 'backups'),
    logsDir: join(dataDir, 'logs'),
    logFile: join(dataDir, 'logs', 'app.log'),
    tmpDir: join(dataDir, 'tmp'),
  };
}

export interface SystemPaths {
  root: string;
  aosDir: string;
  manifest: string;
  db: string;
  agentsDir: string;
  migrationBackups: string;
  trashDir: string;
  templatesDir: string;
}

export const AOS_DIR = '.aos';

export function systemPaths(root: string): SystemPaths {
  const aosDir = join(root, AOS_DIR);
  return {
    root,
    aosDir,
    manifest: join(aosDir, 'system.json'),
    db: join(aosDir, 'system.db'),
    agentsDir: join(aosDir, 'agents'),
    migrationBackups: join(aosDir, 'migration-backups'),
    trashDir: join(root, '.trash'),
    templatesDir: join(root, 'Templates'),
  };
}
