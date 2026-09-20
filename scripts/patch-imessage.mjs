import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Pin the exact vendor artifacts; never apply a fuzzy patch to a new upstream build.
const root = join(process.cwd(), "node_modules/@photon-ai/imessage-kit");
const original = "var RETRY_ATTEMPTS = 3;";
const patched = "var RETRY_ATTEMPTS = 1; // Chat Bridge: durable outbox owns retries.";
const hashes = {
  "index.js": "413fd0b4bff4367b78f090ba3c0c50451fd67bf6e17568cb7eff94f5c8643284",
  "index.cjs": "7769209ee810f4e7f9c5e2961b4a2b186a198c855448eb5b1cd78a79907f5238",
};
if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== "3.0.0") throw new Error("Unsupported iMessage SDK version.");
for (const [name, hash] of Object.entries(hashes)) {
  const file = join(root, "dist", name), contents = readFileSync(file, "utf8");
  const base = contents.replace(patched, original);
  if (createHash("sha256").update(base).digest("hex") !== hash || base.split(original).length !== 2) {
    throw new Error("Unexpected iMessage SDK artifact: " + name);
  }
  writeFileSync(file, base.replace(original, patched));
}
