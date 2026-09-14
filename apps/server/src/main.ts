import { parseConfig } from "./config.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  let config: ReturnType<typeof parseConfig>;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid server configuration";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const server = await startServer(config);
    let shuttingDown = false;

    const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
      if (shuttingDown) {
        process.exit(signal === "SIGINT" ? 130 : 143);
      }

      shuttingDown = true;
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  } catch {
    process.exitCode = 1;
  }
}

void main();
