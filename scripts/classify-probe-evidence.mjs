#!/usr/bin/env node
import fs from "node:fs";
import { classifyProbeEvidence } from "./lib/probeEvidence.mjs";

let evidence;
let fd;
try {
  if (process.argv.length !== 3 || process.argv[2].startsWith("-")) throw new Error();
  fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.size > 65_536) throw new Error();
  const bytes = Buffer.alloc(65_537);
  const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
  if (length > 65_536) throw new Error();
  evidence = JSON.parse(bytes.subarray(0, length).toString("utf8"));
} catch {
  evidence = null;
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
const result = classifyProbeEvidence(evidence);
console.log(JSON.stringify(result));
process.exitCode = { PASS: 0, FAIL: 1, "NOT VERIFIED": 2, SKIPPED: 3 }[result.classification];
