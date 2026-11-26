import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const CLIENT_ENTRY = path.join(PROJECT_ROOT, 'src', 'client', 'main.ts');
const PORT = Number(process.env.PORT ?? 3000);

let cachedBundle: { code: string; map: string; builtAt: number } | null = null;

async function buildClientBundle(): Promise<{ code: string; map: string }> {
  const result = await Bun.build({
    entrypoints: [CLIENT_ENTRY],
    target: 'browser',
    format: 'esm',
    sourcemap: 'external',
    minify: false,
  });

  if (!result.success) {
    const errors = result.logs.map((l) => l.message).join('\n');
    throw new Error(`Client bundle failed:\n${errors}`);
  }

  let code = '';
  let map = '';
  for (const output of result.outputs) {
    if (output.path.endsWith('.map')) {
      map = await output.text();
    } else if (output.path.endsWith('.js')) {
      code = await output.text();
    }
  }

  cachedBundle = { code, map, builtAt: Date.now() };
  return { code, map };
}

// Pre-warm the bundle on startup so first browser load is instant
await buildClientBundle();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      return new Response(Bun.file(path.join(PUBLIC_DIR, 'index.html')), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (pathname === '/styles.css') {
      return new Response(Bun.file(path.join(PUBLIC_DIR, 'styles.css')), {
        headers: { 'Content-Type': 'text/css; charset=utf-8' },
      });
    }

    if (pathname === '/app.js') {
      try {
        // Rebuild on request in dev so edits show immediately on refresh
        const bundle = await buildClientBundle();
        return new Response(bundle.code, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(`console.error(${JSON.stringify(message)});`, {
          status: 500,
          headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
        });
      }
    }

    if (pathname === '/app.js.map' || pathname === '/main.js.map') {
      if (!cachedBundle) await buildClientBundle();
      return new Response(cachedBundle?.map ?? '{}', {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Pixel Physics running at http://localhost:${server.port}`);
