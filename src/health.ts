import { createServer, type Server } from 'node:http';

export function createHealthServer(isReady: () => boolean): Server {
  const server = createServer((request, response) => {
    const path = request.url?.split('?', 1)[0];
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('{"status":"method_not_allowed"}');
      return;
    }
    if (path === '/healthz' || path === '/readyz') {
      const ready = path === '/healthz' || isReady();
      response.writeHead(ready ? 200 : 503).end(ready ? '{"status":"ok"}' : '{"status":"not_ready"}');
      return;
    }
    response.writeHead(404).end('{"status":"not_found"}');
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;
  return server;
}
