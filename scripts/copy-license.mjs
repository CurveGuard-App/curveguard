import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Copy root MIT LICENSE into packages/cli/LICENSE so npm pack includes it cleanly
const HERE = path.dirname(fileURLToPath(import.meta.url));
fs.copyFileSync(path.resolve(HERE, "..", "LICENSE"), path.resolve(HERE, "..", "packages", "cli", "LICENSE"));
