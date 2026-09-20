import { join, isAbsolute } from "node:path";
import { createService } from "./service.js";
import { appVersion } from "./version.js";

process.umask(0o077);
const [flag, directory] = process.argv.slice(2);
if (flag !== "--data-dir" || !directory || !isAbsolute(directory)) {
  process.stderr.write("Expected --data-dir with an absolute application data directory.\n");
  process.exit(2);
}
const service = createService(process.stdin, process.stdout, join(directory, "bridge.sqlite"));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  service.close();
  process.exit(0);
};
service.peer.onClose = stop;
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", () => { process.stderr.write("Local service failed; payloads omitted.\n"); process.exit(1); });
process.on("unhandledRejection", () => { process.stderr.write("Local service failed; payloads omitted.\n"); process.exit(1); });
service.peer.event("service.ready", { version: appVersion, protocolVersion: 1 });
service.start();
