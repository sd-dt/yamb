import type { DatabaseSync } from 'node:sqlite'

export const BLOCK_NODE_TYPES = ['Container', 'Fermenter', 'Distillery', 'Aging', 'Water'] as const
export type BlockNodeType = typeof BLOCK_NODE_TYPES[number]

export interface BlockNode {
  id: number
  alias: string
  blockType: BlockNodeType
  nodeGroup: string | null
  x: number
  y: number
  z: number
  dimension: string
  isDedicated: boolean | null
  itemId: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface RegisterBlockNode {
  alias: string
  blockType: BlockNodeType
  nodeGroup?: string | null
  x: number
  y: number
  z: number
  dimension: string
  isDedicated?: boolean | null
  itemId?: string | null
  createdBy?: string | null
}

interface BlockNodeRow extends Omit<BlockNode, 'isDedicated'> {
  isDedicated: number | null
}

function mapRow (row: BlockNodeRow): BlockNode {
  return {
    ...row,
    isDedicated: row.isDedicated == null ? null : row.isDedicated === 1
  }
}

export default class BlockRegistry {
  private readonly db: DatabaseSync

  constructor (db: DatabaseSync) {
    this.db = db
  }

  register (node: RegisterBlockNode): BlockNode {
    const now = new Date().toISOString()
    const isContainer = node.blockType === 'Container'
    const dedicated = isContainer ? (node.isDedicated ?? false) : null
    const itemId = isContainer && dedicated ? (node.itemId ?? null) : null

    if (dedicated && !itemId) {
      throw new Error('专用容器必须指定 itemId')
    }

    this.db.prepare(`
      INSERT INTO BlockNode (
        alias, blockType, nodeGroup, x, y, z, dimension,
        isDedicated, itemId, createdBy, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        blockType = excluded.blockType,
        nodeGroup = excluded.nodeGroup,
        x = excluded.x,
        y = excluded.y,
        z = excluded.z,
        dimension = excluded.dimension,
        isDedicated = excluded.isDedicated,
        itemId = excluded.itemId,
        updatedAt = excluded.updatedAt
    `).run(
      node.alias,
      node.blockType,
      node.nodeGroup ?? null,
      node.x,
      node.y,
      node.z,
      node.dimension,
      dedicated == null ? null : (dedicated ? 1 : 0),
      itemId,
      node.createdBy ?? null,
      now,
      now
    )

    const result = this.get(node.alias)
    if (!result) throw new Error(`BlockNode registration failed: ${node.alias}`)
    return result
  }

  remove (alias: string): boolean {
    const result = this.db.prepare('DELETE FROM BlockNode WHERE alias = ?').run(alias)
    return result.changes > 0
  }

  get (alias: string): BlockNode | null {
    const row = this.db.prepare(`
      SELECT id, alias, blockType, nodeGroup, x, y, z, dimension,
             isDedicated, itemId, createdBy, createdAt, updatedAt
      FROM BlockNode
      WHERE alias = ?
    `).get(alias) as BlockNodeRow | undefined
    return row ? mapRow(row) : null
  }

  getContainer (alias: string): BlockNode | null {
    const node = this.get(alias)
    return node?.blockType === 'Container' ? node : null
  }

  list (nodeGroup?: string): BlockNode[] {
    const rows = nodeGroup
      ? this.db.prepare(`
          SELECT id, alias, blockType, nodeGroup, x, y, z, dimension,
                 isDedicated, itemId, createdBy, createdAt, updatedAt
          FROM BlockNode
          WHERE nodeGroup = ?
          ORDER BY alias
        `).all(nodeGroup)
      : this.db.prepare(`
          SELECT id, alias, blockType, nodeGroup, x, y, z, dimension,
                 isDedicated, itemId, createdBy, createdAt, updatedAt
          FROM BlockNode
          ORDER BY alias
        `).all()

    return (rows as unknown as BlockNodeRow[]).map(mapRow)
  }

  count (): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM BlockNode').get() as { c: number }
    return row.c
  }
}
