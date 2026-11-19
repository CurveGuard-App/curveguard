import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "packages", "core", "src");
const DEST = path.join(ROOT, "apps", "site", "js", "core");

fs.mkdirSync(DEST, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  if (f.endsWith(".js")) {
    fs.copyFileSync(path.join(SRC, f), path.join(DEST, f));
  }
}
console.log(`[OK] Synced @curveguard/core -> apps/site/js/core (${fs.readdirSync(DEST).length} modules)`);
