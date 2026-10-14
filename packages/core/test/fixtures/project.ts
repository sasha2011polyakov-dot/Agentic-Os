import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Assembled at runtime so secret scanners do not flag this obviously fake test key in the sources. */
const FAKE_KEY_PREFIX = ['sk', ''].join('-');

/** A small but realistic project folder used by integration and e2e tests. */
export const PROJECT_FILES: Record<string, string> = {
  'README.md': `# Demo Shop

An online shop. The architecture is described in [[docs/architecture|the architecture note]].
Login requirements: [[REQ-001]].
`,
  'docs/architecture.md': `---
type: decision
status: accepted
---

# Architecture

Backend on Node.js, storage in PostgreSQL. User sessions are stored in Redis.
See also [[Authorization requirements]].
`,
  'docs/requirements/auth.md': `---
id: REQ-001
title: Authorization requirements
type: requirement
status: draft
priority: high
tags:
  - security
---

# Authorization requirements

The system must let a user log in with email and password.
A session must expire after 30 minutes of inactivity.
`,
  'docs/requirements/sessions.md': `---
id: REQ-002
type: requirement
status: draft
depends_on: "[[REQ-001]]"
---

# Session storage

A session must expire after 24 hours of inactivity.
`,
  'src/auth.ts': `// Implements REQ-001: login by email and password
export class AuthService {
  login(email: string, password: string) {
    return email.length > 0 && password.length > 0;
  }
}

export function logout(): void {}
`,
  'test/auth.test.ts': `// verifies REQ-001
import { AuthService } from '../src/auth';
`,
  'package.json': JSON.stringify({ name: 'demo-shop', version: '1.0.0', main: 'src/index.ts', scripts: { test: 'vitest' } }, null, 2),
  '.gitignore': 'build/\n*.local\n',
  '.env': 'API_KEY=sk-test-should-never-be-indexed-1234567890\n',
  'config/secrets.json': '{"token": "x"}\n',
  'build/output.js': 'console.log("build output");\n',
  'notes.local': 'ignored by gitignore\n',
  'node_modules/lib/index.js': 'module.exports = 1;\n',
  'src/leak.ts': `const key = "${FAKE_KEY_PREFIX}ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";\n`,
};

export async function writeProject(root: string, files: Record<string, string> = PROJECT_FILES): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
  await writeFile(join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://user:secret@example.com/demo/shop.git\n');
}
