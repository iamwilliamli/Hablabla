import { createServer, request as httpRequest, type RequestListener } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/capture.js", ["capture.js", "text/javascript; charset=utf-8"]],
  ["/quality.js", ["quality.js", "text/javascript; charset=utf-8"]],
  ["/pcm-worklet.js", ["../examples/hablabla-pcm16-worklet.js", "text/javascript; charset=utf-8"]],
]);

export function isPrivatePeer(address = ""): boolean {
  const value = address.replace(/^::ffff:/, "");
  if (value === "::1" || /^(fc|fd|fe80:)/i.test(value)) return true;
  const parts = value.split(".").map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) ||
     (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254));
}

export function createDemoServer(options: {
  upstream: string; apiKey: string; origin: string; additionalOrigins?: string[];
  tls?: { key: Buffer; cert: Buffer }; lan?: boolean;
}) {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") {
    throw new Error("The speech test console requires a loopback HTTP gateway.");
  }
  const origins = [options.origin, ...(options.additionalOrigins ?? [])].map(value => new URL(value));
  const handler: RequestListener = async (request, response) => {
    const origin = origins.find(value => value.host === request.headers.host);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const error = (status: number, message: string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message } }));
    };
    // LAN access is explicitly enabled by the launcher; arbitrary hosts remain rejected.
    if (!origin || (options.lan && !isPrivatePeer(request.socket.remoteAddress)) ||
        (request.headers.origin && request.headers.origin !== origin.origin) ||
        request.headers["sec-fetch-site"] === "cross-site") {
      error(403, "Open this console using one of its printed local or LAN URLs.");
      return;
    }
    const path = new URL(request.url ?? "/", origin).pathname;
    if (path === "/favicon.ico") { response.writeHead(204).end(); return; }
    const asset = assets.get(path);
    if (asset && request.method === "GET") {
      try {
        response.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
        response.setHeader("permissions-policy", "microphone=(self)");
        const content = await readFile(fileURLToPath(new URL(`../demo/${asset[0]}`, import.meta.url)));
        response.writeHead(200, { "content-type": asset[1] });
        response.end(content);
      } catch { error(500, "Could not load the local test console asset."); }
      return;
    }
    const method = request.method ?? "GET";
    const route =
      (method === "GET" && path === "/api/capabilities") ? "/v1/capabilities" :
      (method === "POST" && /^\/api\/(parakeet|nemotron)\/sessions$/.test(path)) ? path.replace("/api/", "/v1/") :
      (method === "POST" && path === "/api/jobs") ? "/v1/moss/transcriptions" :
      (["GET", "DELETE"].includes(method) && /^\/api\/jobs\/moss_[a-f0-9]+$/.test(path)) ? path.replace("/api/jobs/", "/v1/moss/transcriptions/") : null;
    if (!route) { error(404, "Unknown test console route."); return; }
    if (method !== "GET" && (request.headers.origin !== origin.origin || request.headers["x-hablabla-demo"] !== "1")) {
      error(403, "Use the controls on the local test console."); return;
    }
    const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}`, origin: origin.origin };
    for (const name of ["content-type", "content-length", "idempotency-key"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const proxy = httpRequest(new URL(route, upstream), { method, headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, { "content-type": result.headers["content-type"] ?? "application/json" });
      if (route.endsWith("/sessions") && result.statusCode === 201) {
        let data = "";
        result.on("data", chunk => { data += chunk.toString(); });
        result.on("end", () => {
          try {
            const session = JSON.parse(data);
            const ws = new URL(session.websocketUrl);
            session.websocketUrl = `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}${ws.pathname}${ws.search}`;
            response.end(JSON.stringify(session));
          } catch { response.destroy(); }
        });
      } else result.pipe(response);
      result.on("error", () => response.destroy());
    });
    proxy.setTimeout(30_000, () => proxy.destroy(new Error("Gateway timeout")));
    proxy.on("error", () => {
      if (!response.headersSent && !response.destroyed) error(502, "The local speech gateway is unavailable. Check the demo terminal.");
      else response.destroy();
    });
    request.on("aborted", () => proxy.destroy());
    response.on("close", () => { if (!response.writableEnded) proxy.destroy(); });
    request.pipe(proxy);
  };
  const server = options.tls ? createSecureServer(options.tls, handler) : createServer(handler);
  server.on("upgrade", (request, socket, head) => {
    const origin = origins.find(value => value.host === request.headers.host);
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    if (!origin || request.headers.origin !== origin.origin || (options.lan && !isPrivatePeer(request.socket.remoteAddress))) { reject(403); return; }
    const url = new URL(request.url ?? "/", origin);
    if (!/^\/v1\/(parakeet|nemotron)\/stream$/.test(url.pathname) || !/^ticket_[a-f0-9]+$/.test(url.searchParams.get("ticket") ?? "")) { reject(403); return; }
    const headers: Record<string,string> = { origin: origin.origin, connection: "Upgrade", upgrade: "websocket" };
    for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
      if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
    }
    const proxy = httpRequest(new URL(url.pathname + url.search, upstream), { headers });
    proxy.setTimeout(10_000, () => { proxy.destroy(); reject(504); });
    proxy.on("upgrade", (result, upstreamSocket, upstreamHead) => {
      proxy.setTimeout(0);
      const responseHeaders = Object.entries(result.headers).map(([key,value]) => `${key}: ${value}`).join("\r\n");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
    });
    proxy.on("response", result => { result.resume(); reject(result.statusCode ?? 502); });
    proxy.on("error", () => { if (!socket.destroyed) reject(502); });
    socket.on("close", () => proxy.destroy());
    proxy.end();
  });
  return server;
}
