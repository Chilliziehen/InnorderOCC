import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import test from "node:test";

import { createGateway } from "./gateway.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function exchange(port, payload) {
  const socket = createConnection({ host: "127.0.0.1", port });
  await once(socket, "connect");
  socket.write(payload);
  const [data] = await once(socket, "data");
  socket.end();
  return data.toString();
}

test("forwards bytes in both directions and reports healthy", async () => {
  const upstream = createServer((socket) => {
    socket.on("data", (data) => socket.write(`echo:${data}`));
  });
  const upstreamPort = await listen(upstream);
  const gateway = await createGateway(
    [{ name: "echo", listenPort: 0, targetHost: "127.0.0.1", targetPort: upstreamPort }],
    { listenHost: "127.0.0.1", healthPort: 0 },
  );

  try {
    assert.equal(await exchange(gateway.routePorts.echo, "ping"), "echo:ping");
    const response = await fetch(`http://127.0.0.1:${gateway.healthPort}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", routes: 1 });
  } finally {
    await gateway.close();
    await close(upstream);
  }
});

test("isolates an unavailable upstream and remains healthy", async () => {
  const unavailable = createServer();
  const unavailablePort = await listen(unavailable);
  await close(unavailable);
  const gateway = await createGateway(
    [{ name: "unavailable", listenPort: 0, targetHost: "127.0.0.1", targetPort: unavailablePort }],
    { listenHost: "127.0.0.1", healthPort: 0 },
  );

  try {
    const socket = createConnection({ host: "127.0.0.1", port: gateway.routePorts.unavailable });
    await once(socket, "connect");
    await once(socket, "close");
    const response = await fetch(`http://127.0.0.1:${gateway.healthPort}/health`);
    assert.equal(response.status, 200);
  } finally {
    await gateway.close();
  }
});

test("stops accepting connections after close", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const gateway = await createGateway(
    [{ name: "echo", listenPort: 0, targetHost: "127.0.0.1", targetPort: upstreamPort }],
    { listenHost: "127.0.0.1", healthPort: 0 },
  );
  const routePort = gateway.routePorts.echo;

  await gateway.close();
  const socket = createConnection({ host: "127.0.0.1", port: routePort });
  const [error] = await once(socket, "error");
  assert.equal(error.code, "ECONNREFUSED");
  await close(upstream);
});
