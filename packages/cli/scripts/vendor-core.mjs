import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, "..");
const VENDOR_DIR = path.join(CLI_ROOT, "src", "vendor", "core");
const CORE_SRC = path.resolve(CLI_ROOT, "..", "core", "src");

if (process.argv.includes("--clean")) {
  fs.rmSync(path.join(CLI_ROOT, "src", "vendor"), { recursive: true, force: true });
  process.exit(0);
}

fs.mkdirSync(VENDOR_DIR, { recursive: true });
for (const ent of fs.readdirSync(CORE_SRC)) {
  if (ent.endsWith(".js")) {
    fs.copyFileSync(path.join(CORE_SRC, ent), path.join(VENDOR_DIR, ent));
  }
}
