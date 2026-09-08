#!/usr/bin/env node
import { main } from "./updater.mjs";
await main(["install", ...process.argv.slice(2)]);
