import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '../db/db.ts';
import { sha256 } from '../util/hash.ts';
import { nowIso } from '../util/time.ts';

export interface VersionInfo {
  id: number;
  sourceId: string;
  relPath: string;
  docId: string | null;
  hash: string;
  size: number;
  reason: string;
  actor: string;
  createdAt: string;
}

/**
 * Content-addressed version history of documents in one system (equivalent of Obsidian "File recovery",
 * but stored inside the system's own database so it travels with backups and exports).
 */
export class HistoryStore {
  constructor(
    private readonly db: Db,
    private readonly maxVersionsPerFile = 100,
  ) {}

  putBlob(content: string): string {
    const hash = sha256(content);
    const exists = this.db.get<{ hash: string }>('SELECT hash FROM blobs WHERE hash = ?', hash);
    if (!exists) {
      this.db.run('INSERT INTO blobs(hash, size, content, created_at) VALUES (?, ?, ?, ?)', hash, Buffer.byteLength(content), gzipSync(content), nowIso());
    }
    return hash;
  }

  getBlob(hash: string): string | null {
    const row = this.db.get<{ content: Uint8Array }>('SELECT content FROM blobs WHERE hash = ?', hash);
    return row ? gunzipSync(row.content).toString('utf8') : null;
  }

  snapshot(args: { sourceId: string; relPath: string; docId: string | null; content: string; reason: string; actor: string }): number | null {
    const hash = this.putBlob(args.content);
    const last = this.db.get<{ blob_hash: string }>(
      'SELECT blob_hash FROM doc_versions WHERE source_id = ? AND rel_path = ? ORDER BY id DESC LIMIT 1',
      args.sourceId,
      args.relPath,
    );
    if (last?.blob_hash === hash) return null; // identical to the latest snapshot
    const r = this.db.run(
      'INSERT INTO doc_versions(source_id, rel_path, doc_id, blob_hash, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args.sourceId,
      args.relPath,
      args.docId,
      hash,
      args.reason,
      args.actor,
      nowIso(),
    );
    this.prune(args.sourceId, args.relPath);
    return Number(r.lastInsertRowid);
  }

  list(sourceId: string, relPath: string, docId?: string | null): VersionInfo[] {
    const rows = this.db.all<{ id: number; source_id: string; rel_path: string; doc_id: string | null; blob_hash: string; size: number; reason: string; actor: string; created_at: string }>(
      `SELECT v.id, v.source_id, v.rel_path, v.doc_id, v.blob_hash, b.size, v.reason, v.actor, v.created_at
         FROM doc_versions v JOIN blobs b ON b.hash = v.blob_hash
        WHERE (v.source_id = ? AND v.rel_path = ?) OR (? IS NOT NULL AND v.doc_id = ?)
        ORDER BY v.id DESC LIMIT 500`,
      sourceId,
      relPath,
      docId ?? null,
      docId ?? null,
    );
    return rows.map((r) => ({ id: r.id, sourceId: r.source_id, relPath: r.rel_path, docId: r.doc_id, hash: r.blob_hash, size: r.size, reason: r.reason, actor: r.actor, createdAt: r.created_at }));
  }

  get(versionId: number): (VersionInfo & { content: string }) | null {
    const r = this.db.get<{ id: number; source_id: string; rel_path: string; doc_id: string | null; blob_hash: string; reason: string; actor: string; created_at: string }>(
      'SELECT id, source_id, rel_path, doc_id, blob_hash, reason, actor, created_at FROM doc_versions WHERE id = ?',
      versionId,
    );
    if (!r) return null;
    const content = this.getBlob(r.blob_hash);
    if (content === null) return null;
    return { id: r.id, sourceId: r.source_id, relPath: r.rel_path, docId: r.doc_id, hash: r.blob_hash, size: Buffer.byteLength(content), reason: r.reason, actor: r.actor, createdAt: r.created_at, content };
  }

  /** Re-points history of a renamed file so its versions stay visible under the new path. */
  rename(sourceId: string, fromRel: string, toRel: string): void {
    this.db.run('UPDATE doc_versions SET rel_path = ? WHERE source_id = ? AND rel_path = ?', toRel, sourceId, fromRel);
  }

  private prune(sourceId: string, relPath: string): void {
    this.db.run(
      `DELETE FROM doc_versions WHERE source_id = ? AND rel_path = ? AND id NOT IN (
         SELECT id FROM doc_versions WHERE source_id = ? AND rel_path = ? ORDER BY id DESC LIMIT ?)`,
      sourceId,
      relPath,
      sourceId,
      relPath,
      this.maxVersionsPerFile,
    );
  }

  /** Removes blobs no longer referenced by versions, web sources or change sets. */
  collectGarbage(): number {
    return this.db.run(
      `DELETE FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM doc_versions)
         AND hash NOT IN (SELECT content_blob FROM web_sources WHERE content_blob IS NOT NULL)
         AND hash NOT IN (SELECT base_blob FROM change_set_files WHERE base_blob IS NOT NULL)
         AND hash NOT IN (SELECT new_blob FROM change_set_files WHERE new_blob IS NOT NULL)`,
    ).changes;
  }
}
