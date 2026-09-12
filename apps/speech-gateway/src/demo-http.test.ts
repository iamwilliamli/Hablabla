import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDemoServer } from "./demo-http.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function close(server: Server) { server.closeAllConnections(); server.close(); }

// Node fetch normalizes Host. Use HTTP directly to exercise hostile Host headers.
async function fetch(url: string, options: RequestInit = {}): Promise<Response> {
  const input = new Request(url, options);
  const body = options.body ? Buffer.from(await input.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: input.method, headers: Object.fromEntries(input.headers) }, async result => {
      const chunks: Buffer[] = [];
      for await (const chunk of result) chunks.push(Buffer.from(chunk));
      resolve(new Response(Buffer.concat(chunks), { status: result.statusCode, headers: result.headers as Record<string,string> }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("Console isolates the bearer key and rejects foreign-origin or arbitrary proxy requests", async t => {
  const received: Array<{ path?: string; authorization?: string; origin?: string; body: string }> = [];
  const upstream = createServer(async (request,response) => {
    let body = ""; for await (const chunk of request) body += chunk.toString();
    received.push({path:request.url,authorization:request.headers.authorization,origin:request.headers.origin,body});
    response.setHeader("content-type","application/json"); response.end(JSON.stringify({ok:true}));
  });
  const upstreamURL = await listen(upstream); t.after(() => close(upstream));
  const origin = "http://127.0.0.1:18766";
  const server = createDemoServer({upstream:upstreamURL,apiKey:"test-server-only-key",origin});
  const base = await listen(server); t.after(() => close(server));
  const headers = {host:"127.0.0.1:18766"};
  const page = await fetch(base,{headers});
  assert.equal(page.status,200); assert(!(await page.text()).includes("test-server-only-key"));
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  const good = await fetch(base + "/api/parakeet/sessions",{method:"POST",headers:{...headers,origin,"x-hablabla-demo":"1","content-type":"application/json"},body:'{"language":"en"}'});
  assert.equal(good.status,200); assert.equal(received[0].authorization,"Bearer test-server-only-key");
  assert.equal(received[0].origin,origin); assert.equal(received[0].path,"/v1/parakeet/sessions");
  const forbiddenHeaders: Array<Record<string,string>> = [{origin:"https://evil.example","x-hablabla-demo":"1"},{origin},{origin,"x-hablabla-demo":"1",host:"evil.example"}];
  for (const extra of forbiddenHeaders) {
    assert.equal((await fetch(base+"/api/jobs",{method:"POST",headers:{...headers,...extra}})).status,403);
  }
  assert.equal((await fetch(base+"/api/capabilities",{headers:{...headers,"sec-fetch-site":"cross-site"}})).status,403);
  assert.equal((await fetch(base+"/api/../../.env",{headers})).status,404);
  assert.equal((await fetch(base+"/api/arbitrary-target",{headers})).status,404);
  assert.equal(received.length,1);
});

test("Console forwards multipart bytes and job cancellation only to the fixed local gateway", async t => {
  let path = "", body = Buffer.alloc(0), key = "";
  const upstream = createServer(async (request,response) => {
    path = request.url!; const chunks: Buffer[] = []; for await(const chunk of request) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks); key = String(request.headers["idempotency-key"] ?? "");
    response.setHeader("content-type","application/json"); response.end('{"status":"cancelled"}');
  });
  const upstreamURL = await listen(upstream); t.after(() => close(upstream));
  const origin = "http://127.0.0.1:18766", headers = {host:"127.0.0.1:18766",origin,"x-hablabla-demo":"1"};
  const server = createDemoServer({upstream:upstreamURL,apiKey:"private",origin}); const base = await listen(server); t.after(() => close(server));
  const form = new FormData(); form.set("audio",new Blob([new Uint8Array([0,255,128,42])],{type:"audio/wav"}),"recording.wav");
  assert.equal((await fetch(base+"/api/jobs",{method:"POST",headers:{...headers,"idempotency-key":"retry-key"},body:form})).status,200);
  assert.equal(path,"/v1/moss/transcriptions"); assert.equal(key,"retry-key"); assert(body.includes(Buffer.from([0,255,128,42])));
  assert.equal((await fetch(base+"/api/jobs/moss_abcdef",{method:"DELETE",headers})).status,200);
  assert.equal(path,"/v1/moss/transcriptions/moss_abcdef");
});

test("LAN address checks exclude public peers", async () => {
  const {isPrivatePeer} = await import("./demo-http.js");
  for(const address of ["127.0.0.1","192.168.0.20","10.1.2.3","172.16.0.1","172.31.0.1","::ffff:192.168.1.3","::1"]) assert(isPrivatePeer(address));
  for(const address of ["8.8.8.8","172.32.0.1","192.169.1.2","unknown",""]) assert(!isPrivatePeer(address));
});

test("Session URLs and framed WebSocket audio pass through the console origin", async t => {
  const {WebSocket,WebSocketServer} = await import("ws");
  const origin = "http://127.0.0.1:18766";
  const upstream = createServer((_request,response) => {
    response.writeHead(201,{"content-type":"application/json"});
    response.end(JSON.stringify({sessionId:"test-session",websocketUrl:"ws://127.0.0.1:1/v1/parakeet/stream?ticket=ticket_abc123"}));
  });
  const wss = new WebSocketServer({server:upstream});
  let upstreamOrigin;
  wss.on("connection",(ws,request) => {
    upstreamOrigin = request.headers.origin;
    ws.on("message",(bytes,binary) => ws.send(bytes,{binary}));
  });
  const upstreamURL=await listen(upstream); t.after(() => {wss.close(); close(upstream);});
  const server=createDemoServer({upstream:upstreamURL,apiKey:"private",origin}); const base=await listen(server); t.after(() => close(server));
  const response=await fetch(base+"/api/parakeet/sessions",{method:"POST",headers:{host:"127.0.0.1:18766",origin,"x-hablabla-demo":"1","content-type":"application/json"},body:"{}"});
  const session=await response.json(); assert.equal(session.websocketUrl,"ws://127.0.0.1:18766/v1/parakeet/stream?ticket=ticket_abc123");
  const socket=new WebSocket(base.replace("http:","ws:")+"/v1/parakeet/stream?ticket=ticket_abc123",{origin,headers:{host:"127.0.0.1:18766"},handshakeTimeout:3000});
  t.after(() => socket.terminate());
  const packet=Buffer.from([0,0,0,0,1,0,0,0,255,127]);
  await new Promise<void>((resolve,reject) => {
    socket.on("error",reject); socket.on("open",()=>socket.send(packet));
    socket.on("message",(data,binary)=>{try {assert(binary);assert.deepEqual(Buffer.from(data as Buffer),packet);socket.close();resolve();}catch(error){reject(error);}});
  });
  assert.equal(upstreamOrigin,origin);
});
