import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Synchronous transactions preserve D1 batch atomicity across the shared repositories.
export function createDatabase(path) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  function statement(sql, values = []) {
    const native = sqlite.prepare(sql);
    return {
      bind(...bound) { return statement(sql, bound); },
      async first(column) { const row = native.get(...values); return row ? (column === undefined ? row : row[column]) : null; },
      async all() { return {success:true, results:native.all(...values)}; },
      async run() { return this.execute(); },
      execute() {
        const result = native.run(...values);
        return {success:true, meta:{changes:Number(result.changes), last_row_id:Number(result.lastInsertRowid)}};
      },
    };
  }
  const transactionSync = callback => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = callback(); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  return {
    sqlite, transactionSync, prepare:statement,
    async batch(statements) { return transactionSync(() => statements.map(s => s.execute())); },
    close() { sqlite.close(); },
  };
}

export async function initializeDatabase(database, root, seed) {
  const {sqlite, transactionSync} = database;
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const fresh = tables.length === 0;
  if (!fresh && !tables.some(row => row.name === 'local_migrations')) throw new Error('This database was not created by computer setup. Use a new private data directory.');
  sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT');
  for (const name of (await readdir(join(root,'worker/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
    const sql = await readFile(join(root,'worker/migrations',name),'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const previous = sqlite.prepare('SELECT digest FROM local_migrations WHERE name=?').get(name);
    if (previous && previous.digest !== digest) throw new Error(`Applied migration changed: ${name}. Restore the matching code before starting.`);
    if (!previous) transactionSync(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO local_migrations VALUES (?,?)').run(name,digest);
    });
  }
  // Commit the seed marker with its records so interrupted first setup resumes safely.
  if (!sqlite.prepare("SELECT 1 FROM local_migrations WHERE name='seed:self-host'").get()) transactionSync(() => {
    sqlite.exec(seed);
    sqlite.prepare('INSERT INTO local_migrations VALUES (?,?)').run('seed:self-host',createHash('sha256').update(seed).digest('hex'));
  });
  return;
}
export async function openLocalDatabase(path, root) {
  const seed = await readFile(join(root,'worker/seeds/self-host.sql'),'utf8');
  const database = createDatabase(path);
  try { await initializeDatabase(database,root,seed); return database; }
  catch (error) { database.close(); throw error; }
}

export async function createFileBucket(directory, database) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const {sqlite} = database;
  sqlite.exec('CREATE TABLE IF NOT EXISTS local_objects (key TEXT PRIMARY KEY, file TEXT NOT NULL, size INTEGER NOT NULL, metadata TEXT NOT NULL) STRICT');
  return {
    async put(key, body, options = {}) {
      const bytes = typeof body === 'string' ? Buffer.from(body) : new Uint8Array(await new Response(body).arrayBuffer());
      const file = randomUUID();
      const temporary = join(directory,`${file}.tmp`), destination = join(directory,file);
      await writeFile(temporary,bytes,{mode:0o600});
      await rename(temporary,destination);
      const old = sqlite.prepare('SELECT file FROM local_objects WHERE key=?').get(key);
      try {
        sqlite.prepare('INSERT INTO local_objects VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET file=excluded.file,size=excluded.size,metadata=excluded.metadata').run(key,file,bytes.length,JSON.stringify(options));
      } catch (error) { await unlink(destination); throw error; }
      if (old) await unlink(join(directory,old.file));
      return {key,size:bytes.length};
    },
    async get(key) {
      const row = sqlite.prepare('SELECT * FROM local_objects WHERE key=?').get(key);
      if (!row) return null;
      const bytes = await readFile(join(directory,row.file));
      const metadata = JSON.parse(row.metadata);
      return {key, size:row.size, ...metadata, body:new Blob([bytes]).stream(), async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength); }, async text() { return bytes.toString('utf8'); }};
    },
    async delete(key) {
      if (Array.isArray(key)) { for (const value of key) await this.delete(value); return; }
      const row = sqlite.prepare('SELECT file FROM local_objects WHERE key=?').get(key);
      if (!row) return;
      // Keep the mapping until filesystem deletion succeeds, so failures remain diagnosable.
      try { await unlink(join(directory,row.file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      sqlite.prepare('DELETE FROM local_objects WHERE key=?').run(key);
    },
    async list({cursor = ''} = {}) {
      const rows = sqlite.prepare('SELECT key,size FROM local_objects WHERE key>? ORDER BY key LIMIT 1001').all(cursor);
      const truncated = rows.length > 1000;
      return {objects:rows.slice(0,1000),truncated,...(truncated?{cursor:rows[999].key}:{})};
    },
  };
}

export function durableSqlStorage(database) {
  return {
    sql:{exec(sql,...values) { const statement=database.sqlite.prepare(sql); return statement.columns().length ? statement.all(...values) : (statement.run(...values), []); }},
    transactionSync:database.transactionSync,
  };
}
