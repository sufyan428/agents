import crypto from 'node:crypto';
import http from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Registry, collectDefaultMetrics } from 'prom-client';
import { buildHealthReport, healthHttpStatus, type HealthCheck } from '@ragent/agent-protocol';
import { newCorrelationId } from '@ragent/agent-protocol';
import type { AgentLogger } from './logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export interface ServerOptions {
  agent: string;
  logger: AgentLogger;
  port: number;
  host?: string;
  healthPath?: string;
  metricsPath?: string;

  /**
   * Shared secret required on mutating requests.
   *
   * When absent, mutating routes are refused outright rather than left open.
   * An unauthenticated endpoint that can stop an agent or trigger a router
   * failover is not an acceptable default, and "no token configured" must fail
   * closed, not open.
   */
  authToken?: string;

  /**
   * Paths exempt from auth even for mutating methods. Use sparingly.
   */
  publicPaths?: string[];

  /** Allowed CORS origins. Empty means no cross-origin access at all. */
  corsOrigins?: string[];

  /** Requests per window per IP. */
  rateLimit?: { windowMs: number; max: number };
  /** A tighter limit for expensive routes, e.g. anything calling a model. */
  expensiveRateLimit?: { windowMs: number; max: number };

  /** Supplies the health checks for this agent on each probe. */
  healthChecks?: () => HealthCheck[] | Promise<HealthCheck[]>;

  version?: string;
  bodyLimit?: string;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Length-independent, timing-safe comparison. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface AgentServer {
  app: Express;
  registry: Registry;
  /** Attach routes before calling listen. */
  listen(): Promise<http.Server>;
  close(): Promise<void>;
}

export function createServer(opts: ServerOptions): AgentServer {
  const {
    agent, logger, port,
    host = '127.0.0.1',
    healthPath = '/health',
    metricsPath = '/metrics',
    publicPaths = [],
    corsOrigins = [],
    bodyLimit = '256kb',
  } = opts;

  const app = express();
  let server: http.Server | undefined;

  // Trust only a loopback proxy by default, so rate limiting keys off the real
  // peer rather than a client-supplied X-Forwarded-For.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  const registry = new Registry();
  registry.setDefaultLabels({ agent });
  collectDefaultMetrics({ register: registry });

  app.use(helmet());

  app.use(
    cors({
      origin: corsOrigins.length ? corsOrigins : false,
      credentials: false,
    }),
  );

  app.use(express.json({ limit: bodyLimit }));

  // Correlation id: honour an inbound one so a trace survives across agents.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inbound = req.get('x-correlation-id');
    req.correlationId = inbound && /^[\w.-]{1,64}$/.test(inbound) ? inbound : newCorrelationId();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });

  const limiter = rateLimit({
    windowMs: opts.rateLimit?.windowMs ?? 60_000,
    max: opts.rateLimit?.max ?? 120,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);

  /** Apply to routes that cost money or heavy work. */
  const expensiveLimiter = rateLimit({
    windowMs: opts.expensiveRateLimit?.windowMs ?? 60_000,
    max: opts.expensiveRateLimit?.max ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
  });
  (app as Express & { expensiveLimiter?: unknown }).expensiveLimiter = expensiveLimiter;

  // ---- auth -------------------------------------------------------------
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!MUTATING.has(req.method)) return next();
    if (publicPaths.includes(req.path)) return next();

    if (!opts.authToken) {
      logger.warn('Rejected a mutating request: no AGENT_API_TOKEN is configured', {
        method: req.method, path: req.path, correlationId: req.correlationId,
      });
      res.status(503).json({
        success: false,
        error: 'This endpoint is disabled because no API token is configured. Set AGENT_API_TOKEN.',
      });
      return;
    }

    const header = req.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided || !tokensMatch(provided, opts.authToken)) {
      logger.warn('Rejected a mutating request: bad or missing token', {
        method: req.method, path: req.path, ip: req.ip, correlationId: req.correlationId,
      });
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    next();
  });

  // ---- health & metrics -------------------------------------------------
  app.get(healthPath, async (_req: Request, res: Response) => {
    const checks = (await opts.healthChecks?.()) ?? [];
    const report = buildHealthReport({ agent, checks, version: opts.version });
    res.status(healthHttpStatus(report.status)).json(report);
  });

  app.get(metricsPath, async (_req: Request, res: Response) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  const api: AgentServer = {
    app,
    registry,

    listen(): Promise<http.Server> {
      // Terminal handlers must be registered after the caller's routes, so they
      // are attached here rather than during construction.
      app.use((req: Request, res: Response) => {
        res.status(404).json({ success: false, error: 'Not found', path: req.path });
      });

      app.use((err: Error & { status?: number; statusCode?: number }, req: Request, res: Response, _next: NextFunction) => {
        const status = err.status ?? err.statusCode ?? 500;

        // Client errors (bad JSON, oversized body) are the caller's to fix, so
        // the status has to survive - a flat 500 tells them nothing. The
        // message is still generic; only the status class is disclosed.
        if (status >= 400 && status < 500) {
          logger.warn(`Rejected request: ${err.message}`, {
            status, path: req.path, correlationId: req.correlationId,
          });
          res.status(status).json({
            success: false,
            error: status === 413 ? 'Payload too large' : 'Bad request',
            correlationId: req.correlationId,
          });
          return;
        }

        // Server errors: log the detail, return an opaque message plus the
        // correlation id, so an operator can find the log line without the
        // client learning internal paths or stack contents.
        logger.error(`Unhandled error: ${err.message}`, {
          stack: err.stack, path: req.path, correlationId: req.correlationId,
        });
        res.status(500).json({
          success: false,
          error: 'Internal server error',
          correlationId: req.correlationId,
        });
      });

      return new Promise((resolve, reject) => {
        server = app.listen(port, host, () => {
          if (host === '0.0.0.0' || host === '::') {
            logger.warn(
              `${agent} is listening on ${host}:${port} - reachable from any network interface. ` +
                'Put authentication and TLS in front of it, or bind 127.0.0.1.',
            );
          } else {
            logger.info(`${agent} listening on http://${host}:${port}`);
          }
          resolve(server as http.Server);
        });
        server.on('error', reject);
      });
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        const s = server;
        if (!s || !s.listening) {
          server = undefined;
          return resolve();
        }
        server = undefined; // idempotent: a second close() is a no-op

        // Drop keep-alive sockets FIRST. They otherwise hold the process open
        // past close(), and tearing them down after close() has already begun
        // trips a libuv assertion on Windows.
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
    },
  };

  return api;
}

/** The tighter limiter, for mounting on expensive routes. */
export function expensiveLimiterFor(app: Express): express.RequestHandler {
  return (app as Express & { expensiveLimiter: express.RequestHandler }).expensiveLimiter;
}

export interface ShutdownOptions {
  logger: AgentLogger;
  /** Run in order. Each gets `timeoutMs` before the process exits regardless. */
  onShutdown: Array<() => void | Promise<void>>;
  timeoutMs?: number;
}

/**
 * Installs signal handlers that drain once and then exit.
 *
 * Guards against re-entry, because a second Ctrl-C during shutdown otherwise
 * runs every handler twice, and forces exit on a timer so one hung handler
 * cannot leave the process alive forever.
 */
export function installShutdown(opts: ShutdownOptions): void {
  const { logger, onShutdown, timeoutMs = 10_000 } = opts;
  let shuttingDown = false;

  const run = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} during shutdown - ignoring`);
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);

    const forced = setTimeout(() => {
      logger.error(`Shutdown exceeded ${timeoutMs}ms - forcing exit`);
      process.exit(1);
    }, timeoutMs);
    forced.unref();

    for (const fn of onShutdown) {
      try {
        await fn();
      } catch (err) {
        logger.error(`Shutdown step failed: ${(err as Error).message}`);
      }
    }

    clearTimeout(forced);
    logger.info('Shutdown complete');

    // Deliberately NOT process.exit(). Calling it here truncates pending I/O -
    // including the log write immediately above - and on Windows, exiting while
    // libuv handles are still closing trips
    //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src/win/async.c
    // on every clean shutdown. Setting exitCode and letting the loop drain is
    // both correct and quiet. The unref'd timer below does not hold the process
    // open, but will still fire and force the exit if something else does.
    process.exitCode = 0;
    const grace = setTimeout(() => {
      logger.warn('Event loop still busy after shutdown; forcing exit');
      process.exit(0);
    }, 2000);
    grace.unref();
  };

  process.on('SIGTERM', () => void run('SIGTERM'));
  process.on('SIGINT', () => void run('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
    void run('uncaughtException');
  });

  // Logged but not fatal. Killing a monitoring agent over one unhandled
  // rejection - often a transient device timeout - causes more downtime than
  // it prevents.
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
