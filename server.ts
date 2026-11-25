import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const MOVGR_BASE = 'https://movgr.apis.mianfg.me';
const ALLOWED_PATH_RE = /^\/(bus|ctagr|metro)\/(paradas|parada\/[A-Za-z0-9_-]+|llegadas\/[A-Za-z0-9_-]+|lineas(\/[A-Za-z0-9_-]+)?)$/;

interface CacheEntry {
  data: unknown;
  status: number;
  expiresAt: number;
}

const apiCache = new Map<string, CacheEntry>();

function getCacheTtlMs(reqPath: string): number {
  if (reqPath.includes('/llegadas/')) return 12_000;
  if (/\/lineas\/.+/.test(reqPath)) return 15_000;
  return 300_000;
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/movgr', async (req, res) => {
    const subPath = req.path;

    if (!ALLOWED_PATH_RE.test(subPath)) {
      res.status(400).json({ detail: 'Ruta de API no válida' });
      return;
    }

    const now = Date.now();
    const cached = apiCache.get(subPath);
    if (cached && cached.expiresAt > now) {
      res.status(cached.status).json(cached.data);
      return;
    }

    try {
      const upstream = await fetch(`${MOVGR_BASE}${subPath}`, {
        signal: AbortSignal.timeout(8000),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'GranadaMueve-PWA/1.0',
        },
      });
      const text = await upstream.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { detail: text || 'Respuesta inválida de MovGR' };
      }

      if (upstream.ok) {
        apiCache.set(subPath, {
          data: payload,
          status: upstream.status,
          expiresAt: now + getCacheTtlMs(subPath),
        });
      }

      res.status(upstream.status).json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error de red';
      res.status(502).json({ detail: 'No se pudo conectar con MovGR', error: message });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  const disableHmr = process.env.DISABLE_HMR === 'true';
  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server: httpServer },
        ws: disableHmr ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { maxAge: '1d' }));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Granada Mueve escuchando en http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Error iniciando el servidor:', err);
  process.exit(1);
});
