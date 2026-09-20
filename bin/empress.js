#!/usr/bin/env node
// empress CLI entry point.
import { main } from "../src/cli/main.js";

main(process.argv.slice(2), process.cwd()).then(
  () => {
    if (process.exitCode === undefined) process.exitCode = 0;
  },
  (err) => {
    console.error("empress:", err && err.message ? err.message : err);
    process.exitCode = 1;
  }
);