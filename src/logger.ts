import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'TUNE';

const COLORS: Record<Level, string> = {
  DEBUG: '\x1b[36m', // Cyan
  INFO:  '\x1b[32m', // Green
  WARN:  '\x1b[33m', // Yellow
  ERROR: '\x1b[31m', // Red
  TRADE: '\x1b[35m', // Magenta
  TUNE:  '\x1b[34m', // Blue
};
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';

let logStream: fs.WriteStream | null = null;

function getLogStream(logDir: string): fs.WriteStream {
  if (!logStream) {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logDir, `arbex-${dateStr}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }
  return logStream;
}

export class Logger {
  private static debugEnabled = process.env.DEBUG === 'true';
  private static logDir = CONFIG.LOG_DIR ?? './logs';

  constructor(private readonly module: string) {}

  debug(msg: string, meta?: Record<string, unknown>): void {
    if (!Logger.debugEnabled) return;
    this.print('DEBUG', msg, meta);
  }

  info(msg: string,  meta?: Record<string, unknown>): void { this.print('INFO',  msg, meta); }
  warn(msg: string,  meta?: Record<string, unknown>): void { this.print('WARN',  msg, meta); }
  error(msg: string, err?: Error | unknown):          void {
    const suffix = err instanceof Error
      ? ` — ${err.message}`
      : err !== undefined ? ` — ${String(err)}` : '';
    this.print('ERROR', msg + suffix);
  }

  /** Structured trade result log — always written regardless of DEBUG flag. */
  trade(msg: string, meta?: Record<string, unknown>): void {
    this.print('TRADE', msg, meta);
  }

  /** Auto-tune adjustment log. */
  tune(msg: string, meta?: Record<string, unknown>): void {
    this.print('TUNE', msg, meta);
  }

  private print(level: Level, msg: string, meta?: Record<string, unknown>): void {
    const ts    = new Date().toISOString();
    const color = COLORS[level];
    const tag   = `[${this.module}]`.padEnd(14);
    const metaSuffix = meta ? ' ' + JSON.stringify(meta) : '';
    const line  = `${ts} ${level.padEnd(5)} ${tag} ${msg}${metaSuffix}`;

    // Console (coloured)
    console.log(`${DIM}${ts}${RESET} ${color}${level.padEnd(5)}${RESET} ${DIM}${tag}${RESET} ${msg}${metaSuffix}`);

    // File (plain text)
    try {
      getLogStream(Logger.logDir).write(line + '\n');
    } catch {
      // Never crash the bot over a log write failure
    }
  }

  static flushAndClose(): void {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
  }
}

/** Module-level singleton for convenience (used by index.ts and tests). */
export const logger = new Logger('ARBEX');
