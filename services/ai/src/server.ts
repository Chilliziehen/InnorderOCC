import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { registerShutdownHandlers } from "./shutdown.js";

const config = loadConfig();
const app = buildApp(config);
const removeShutdownHandlers = registerShutdownHandlers(app);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  removeShutdownHandlers();
  app.log.error(error);
  console.error("AI service failed to start", error);
  await app.close();
  process.exitCode = 1;
}
