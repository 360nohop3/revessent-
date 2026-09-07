/**
 * Worker ENTRYPOINT. The library module (bootstrap.ts) exports a composable
 * `bootstrap()` (tests import it and drive shutdown themselves); this file is
 * the process entry that actually starts the worker and keeps running.
 */
import { bootstrap } from "./bootstrap.js";
import { log } from "./logger.js";

const instance = bootstrap();

// Keep the event loop alive; SIGINT/SIGTERM are handled by the shutdown
// handlers registered inside bootstrap(). An unexpected main-loop exit is
// surfaced loudly — the durable job ledger is authoritative and nothing is
// lost by a crash (recovery reconstructs deliveries from the DB).
process.on("exit", () => {
  log.info("worker process exiting");
});
void instance;
