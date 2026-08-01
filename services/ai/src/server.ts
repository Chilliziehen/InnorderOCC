import { createCompositionRoot } from "./composition-root.js";
import { loadConfig } from "./config.js";
import { registerShutdownHandlers } from "./shutdown.js";

let root: Awaited<ReturnType<typeof createCompositionRoot>> | undefined;
let removeShutdownHandlers: (() => void) | undefined;
try {
  const config = loadConfig();
  root = await createCompositionRoot(config);
  const app = root.app;
  removeShutdownHandlers = registerShutdownHandlers(app);
  await app.listen({ host: config.host, port: config.port });
} catch {
  removeShutdownHandlers?.();
  await root?.close().catch(() => undefined);
  console.error("AI service failed to start");
  process.exitCode = 1;
}
