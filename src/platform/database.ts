import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'

const databases = new Map<string, DatabaseSync>()

function ensureSchema (db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelist (
      game_name TEXT PRIMARY KEY,
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS containers (
      alias     TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      x         INTEGER NOT NULL,
      y         INTEGER NOT NULL,
      z         INTEGER NOT NULL,
      dimension TEXT NOT NULL DEFAULT 'overworld',
      added_by  TEXT NOT NULL,
      added_at  TEXT NOT NULL
    )
  `)
}

export function initDatabase (dbPath: string): DatabaseSync {
  const existing = databases.get(dbPath)
  if (existing) return existing

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  ensureSchema(db)
  databases.set(dbPath, db)
  console.log(`[DB] SQLite ready: ${dbPath}`)
  return db
}

export function getDatabase (dbPath?: string): DatabaseSync {
  if (dbPath) {
    const db = databases.get(dbPath)
    if (!db) throw new Error(`Database not initialized: ${dbPath}`)
    return db
  }
  if (databases.size === 1) return [...databases.values()][0]
  if (databases.size === 0) throw new Error('Database not initialized')
  throw new Error('Multiple databases open; pass dbPath to getDatabase()')
}

export function closeDatabase (dbPath?: string): void {
  if (dbPath) {
    const db = databases.get(dbPath)
    if (!db) return
    db.close()
    databases.delete(dbPath)
    return
  }
  for (const [key, db] of databases) {
    try { db.close() } catch { /* ignore */ }
    databases.delete(key)
  }
}

/** 从旧版 whitelist.json 迁移数据（仅当表为空时） */
export function migrateFromJson (db: DatabaseSync, jsonPath: string): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM whitelist').get() as { c: number }
  if (count.c > 0) return

  if (!fs.existsSync(jsonPath)) return

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Record<string, { addedBy?: string; addedAt?: string }>
    const insert = db.prepare(
      'INSERT OR IGNORE INTO whitelist (game_name, added_by, added_at) VALUES (?, ?, ?)'
    )

    db.exec('BEGIN')
    try {
      let migrated = 0
      for (const [name, info] of Object.entries(data)) {
        insert.run(name, info.addedBy || 'migration', info.addedAt || new Date().toISOString())
        migrated++
      }
      db.exec('COMMIT')
      if (migrated > 0) {
        console.log(`[DB] Migrated ${migrated} entries from ${jsonPath}`)
      }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    console.warn('[DB] JSON migration skipped:', (err as Error).message)
  }
}

export type { DatabaseSync }
