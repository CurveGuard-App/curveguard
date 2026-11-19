#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`curveguard error: ${err?.message || err}\n`);
    process.exitCode = 1;
  }
);
