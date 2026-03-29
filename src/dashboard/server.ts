import express, { Request, Response } from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import path from 'path';
import { PnLState, DashboardEvent, AlertEvent, BundleResult } from '../types';
import { CONFIG } from '../config';
import { Logger } from '../logger';
import { PnLTracker } from '../tracker/pnl';

const log = new Logger('Dashboard');

export class DashboardServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();

  constructor(private pnl: PnLTracker) {
    // ── Express setup ───────────────────────────────────────────────────────
    this.app = express();
    this.app.use(express.json());

    // Serve the dashboard HTML
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'mev-dashboard.html'));
    });

    // Current P&L snapshot as JSON
    this.app.get('/status', (_req: Request, res: Response) => {
      res.json(this.pnl.getState());
    });

    // Remote stop endpoint (password-protected)
    this.app.post('/stop', (req: Request, res: Response) => {
      if (req.headers['x-secret'] !== CONFIG.DASHBOARD_SECRET) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json({ ok: true });
      log.warn('Remote stop requested — shutting down.');
      process.exit(0);
    });

    // ── HTTP + WebSocket server ─────────────────────────────────────────────
    this.server = http.createServer(this.app);

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      log.info(`Client connected (total: ${this.clients.size})`);

      // Send current state immediately on connect
      const state = this.pnl.getState();
      this._send(ws, { type: 'status', payload: state });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info(`Client disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', (err: Error) => {
        log.warn(`WebSocket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    this.server.listen(CONFIG.DASHBOARD_PORT, () => {
      log.info(`Live at http://localhost:${CONFIG.DASHBOARD_PORT}`);
    });
  }

  broadcast(event: DashboardEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  pushTrade(result: BundleResult): void {
    this.broadcast({ type: 'trade', payload: result });
  }

  pushPnL(state: PnLState): void {
    this.broadcast({ type: 'pnl_update', payload: state });
  }

  pushAlert(alert: AlertEvent): void {
    this.broadcast({ type: 'alert', payload: alert });
  }

  pushPrices(priceMap: unknown): void {
    this.broadcast({ type: 'prices', payload: priceMap });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _send(ws: WebSocket, event: DashboardEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }
}
