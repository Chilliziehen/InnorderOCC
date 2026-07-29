import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { pathToFileURL } from "node:url";

const defaultRoutes = [
  { name: "postgres", listenPort: 5432, targetHost: "postgres", targetPort: 5432 },
  { name: "kafka", listenPort: 9092, targetHost: "kafka", targetPort: 9092 },
  { name: "redis", listenPort: 6379, targetHost: "redis", targetPort: 6379 },
  { name: "minio-api", listenPort: 9000, targetHost: "minio", targetPort: 9000 },
  { name: "minio-console", listenPort: 9001, targetHost: "minio", targetPort: 9001 },
  { name: "opa", listenPort: 8181, targetHost: "opa", targetPort: 8181 },
  { name: "ai", listenPort: 3100, targetHost: "ai", targetPort: 3100 },
  { name: "core", listenPort: 8080, targetHost: "core", targetPort: 8080 },
];

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address().port);
    });
  });
}

function stop(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function createGateway(routes, options = {}) {
  const listenHost = options.listenHost ?? "0.0.0.0";
  const healthPort = options.healthPort ?? 18000;
  const sockets = new Set();
  const routePorts = {};

  const routeServers = routes.map((route) => {
    const server = createTcpServer((client) => {
      const upstream = createConnection({ host: route.targetHost, port: route.targetPort });
      sockets.add(client);
      sockets.add(upstream);
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      client.pipe(upstream);
      upstream.pipe(client);

      const release = () => {
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", release);
      upstream.on("close", release);
    });
    return { route, server };
  });

  const healthServer = createHttpServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", routes: routes.length }));
  });

  try {
    for (const { route, server } of routeServers) {
      routePorts[route.name] = await listen(server, route.listenPort, listenHost);
    }
    const actualHealthPort = await listen(healthServer, healthPort, listenHost);
    let closed = false;
    return {
      routePorts: Object.freeze(routePorts),
      healthPort: actualHealthPort,
      async close() {
        if (closed) return;
        closed = true;
        for (const socket of sockets) socket.destroy();
        await Promise.all([...routeServers.map(({ server }) => stop(server)), stop(healthServer)]);
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([...routeServers.map(({ server }) => stop(server)), stop(healthServer)]);
    throw error;
  }
}

async function main() {
  const gateway = await createGateway(defaultRoutes);
  console.log(JSON.stringify({ event: "gateway.started", routes: gateway.routePorts }));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await gateway.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ event: "gateway.failed", message: error.message }));
    process.exitCode = 1;
  });
}
