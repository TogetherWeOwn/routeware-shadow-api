#!/usr/bin/env node
/**
 * Grouped menu of every package.json script.
 *
 * Usage:
 *   npm run help
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatHelpMenu, groupScripts } from "./lib/helpMenu.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { scripts } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

console.log("Run any entry with `npm run <name>`. Lifecycle hooks (predev, ...) run automatically and are hidden.");
console.log(formatHelpMenu(groupScripts(scripts)));
