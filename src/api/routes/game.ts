import { Router, Request, Response } from 'express'
import type GameApiService from '../game-service'

export default function createGameRoutes (gameApiService: GameApiService): Router {
  const router = Router()

  router.get('/status', (_req: Request, res: Response) => {
    res.json(gameApiService.getStatus())
  })

  router.get('/players', (_req: Request, res: Response) => {
    const result = gameApiService.getPlayers()
    res.json(result)
  })

  router.post('/say', (req: Request, res: Response) => {
    const { message } = req.body as { message?: string }
    if (!message) {
      return res.status(400).json({ success: false, message: 'Missing message' })
    }

    const result = gameApiService.say(message)
    res.json(result)
  })

  router.post('/command', (req: Request, res: Response) => {
    const { command, sender } = req.body as { command?: string, sender?: string }
    if (!command) {
      return res.status(400).json({ success: false, message: 'Missing command' })
    }
    const result = gameApiService.invokeCommand(sender || 'player', command)
    res.json(result)
  })

  router.post('/action', (req: Request, res: Response) => {
    const body = req.body as {
      act?: string, target?: string, dir?: string,
      x?: number, y?: number, z?: number,
      yaw?: number, pitch?: number, seconds?: number
    }
    if (!body || !body.act) {
      return res.status(400).json({ success: false, message: 'Missing act' })
    }
    const result = gameApiService.action(body.act, body)
    res.json(result)
  })

  return router
}
