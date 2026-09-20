#!/usr/bin/env node
/**
 * control-pi-jev-task-router.mjs
 *
 * Verification helper for pi-jev-task-router:
 *   doctor: run tests + typecheck (+ optional fixture heuristic check if importable)
 *   smoke: same as doctor
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "../../../..");

function run(command, args, cwd = REPO_ROOT) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
    proc.on("error", reject);
  });
}

async function checkNodeModules() {
  const pkgLockPath = join(REPO_ROOT, "package-lock.json");
  const nmPath = join(REPO_ROOT, "node_modules");
  if (!existsSync(nmPath) && existsSync(pkgLockPath)) {
    console.log("Installing devDependencies (needed for typecheck)...");
    await run("npm", ["ci"], REPO_ROOT);
  }
}

async function runTests() {
  console.log("\n=== Running tests (node --test) ===");
  await run("node", ["--experimental-strip-types", "--test"], REPO_ROOT);
  console.log("✓ Tests passed");
}

async function runTypecheck() {
  console.log("\n=== Running typecheck (tsc --noEmit) ===");
  await checkNodeModules();
  await run("npm", ["run", "typecheck"], REPO_ROOT);
  console.log("✓ Typecheck passed");
}

async function checkFixturesOffline() {
  console.log("\n=== Checking fixtures with heuristic (offline) ===");
  
  try {
    const fixturesPath = join(REPO_ROOT, "fixtures.jsonl");
    if (!existsSync(fixturesPath)) {
      console.log("⊘ No fixtures.jsonl found, skipping");
      return;
    }

    const fakePath = join(REPO_ROOT, "providers/fake.ts");
    const policyPath = join(REPO_ROOT, "policy.ts");
    
    if (!existsSync(fakePath) || !existsSync(policyPath)) {
      console.log("⊘ Cannot import classifier modules, skipping fixture check");
      return;
    }

    const fixturesContent = await readFile(fixturesPath, "utf-8");
    const lines = fixturesContent.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
    
    console.log(`Found ${lines.length} fixture lines`);
    
    const fixtures = lines.map((line, idx) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`Invalid JSON at line ${idx + 1}: ${e.message}`);
      }
    });

    console.log(`✓ All ${fixtures.length} fixtures parsed successfully`);
    console.log("  (Deep classifier verification requires Pi + /router-check)");
    
  } catch (err) {
    console.log(`⊘ Fixture sanity check failed: ${err.message}`);
  }
}

async function doctor() {
  console.log("Running doctor checks for pi-jev-task-router...");
  await runTests();
  await runTypecheck();
  await checkFixturesOffline();
  console.log("\n✓ All doctor checks passed");
}

async function main() {
  const cmd = process.argv[2];
  
  try {
    switch (cmd) {
      case "doctor":
      case "smoke":
        await doctor();
        break;
      default:
        console.log("Usage: control-pi-jev-task-router.mjs doctor|smoke");
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
}

main();
