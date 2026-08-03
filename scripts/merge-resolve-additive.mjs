#!/usr/bin/env node
// Resolve only conflict hunks where one side is empty (a pure addition on the
// other side). Every other hunk is left in place and reported, so semantic
// conflicts always get a human decision.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Line endings are CRLF in this checkout, so every anchor tolerates a stray \r.
const CONFLICT =
  /^<<<<<<< [^\n]*\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> [^\n]*\r?\n/m;

const GIT = ["-c", "safe.directory=*"];

function run(args) {
  try {
    return execFileSync("git", [...GIT, ...args], { encoding: "utf8" });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    return error.stdout ?? "";
  }
}

// Unmerged paths cover the normal case; a marker scan also catches files that
// were staged while conflict markers were still present.
function conflictedFiles() {
  const unmerged = run(["diff", "--name-only", "--diff-filter=U"]);
  const marked = run(["grep", "-l", "-E", "^<<<<<<< |^>>>>>>> "]);
  const paths = [...unmerged.split("\n"), ...marked.split("\n")]
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(paths)];
}

let resolved = 0;
const remaining = [];

for (const file of conflictedFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    remaining.push(`${file} (unreadable: likely add/add or delete conflict)`);
    continue;
  }

  let cursor = 0;
  let output = "";
  let manual = 0;

  for (;;) {
    const match = CONFLICT.exec(text.slice(cursor));
    if (!match) break;
    const start = cursor + match.index;
    const end = start + match[0].length;
    const [, ours, theirs] = match;
    output += text.slice(cursor, start);

    if (theirs === "" && ours !== "") {
      output += ours;
      resolved += 1;
    } else if (ours === "" && theirs !== "") {
      output += theirs;
      resolved += 1;
    } else {
      output += match[0];
      manual += 1;
    }
    cursor = end;
  }
  output += text.slice(cursor);

  writeFileSync(file, output);
  if (manual > 0) remaining.push(`${file} (${manual} hunk(s) need a decision)`);
  else run(["add", "--", file]);
}

console.log(`auto-resolved ${resolved} additive hunk(s)`);
if (remaining.length > 0) {
  console.log("needs manual resolution:");
  for (const entry of remaining) console.log(`  ${entry}`);
  process.exit(1);
}
console.log("all conflicts resolved");
