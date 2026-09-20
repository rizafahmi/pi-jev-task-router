#!/usr/bin/env node
/**
 * Assert that the task-router package actually loaded — once, and as a package.
 *
 * Runs `pi --mode rpc`, asks for `get_commands`, and checks the four commands this
 * extension registers. RPC mode needs no TTY, no auth and no model, which is what
 * makes it usable from CI.
 *
 * What it catches:
 *
 *   1. The package did not load at all (manifest points at the wrong file, the
 *      extension threw during init, `pi install` recorded a source it cannot resolve).
 *   2. The package loaded *twice* — e.g. an auto-discovered checkout plus an installed
 *      package. Pi does not reject duplicate command names; `resolveRegisteredCommands`
 *      in `core/extensions/runner.js` renames the collisions, so you get `/router:1` and
 *      `/router:2` and the plain `/router` stops existing. That silently gives you two
 *      `before_agent_start` handlers and two `setModel()` calls per turn.
 *      (Pi does dedupe two records that resolve to the same path, so the duplication has
 *      to be a genuinely separate copy of the file — a symlink will not reproduce this.)
 *   3. The commands came from auto-discovery instead of the package. `sourceInfo.origin`
 *      is `package` for an installed package and something else for a bare checkout, so
 *      asserting on it is what makes this a test of the *install* rather than of the
 *      code sitting nearby.
 *
 * Usage:
 *   node scripts/check-commands.mjs                 # assert, human-readable
 *   node scripts/check-commands.mjs --json          # dump the raw command list
 *   PI_CODING_AGENT_DIR=/tmp/x node scripts/...     # isolate the config dir
 *
 * Exit codes: 0 = pass, 1 = assertion failed, 2 = could not reach pi at all.
 */

import { spawn } from "node:child_process";

const EXPECTED = ["router", "router-config", "task-router", "router-check"];
const REQUEST_ID = "check-commands-1";
const DEFAULT_TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const timeoutMs = Number(process.env.PI_CHECK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

/** Commands pi renames to avoid a collision look like `name:2`. */
const DUPLICATE_SUFFIX = /^(.+):(\d+)$/;

function fail(message, code = 1) {
	process.stderr.write(`check-commands: ${message}\n`);
	process.exit(code);
}

/**
 * Drive one RPC round trip and return the command list.
 *
 * The request is written and stdin is closed: pi answers `get_commands` before it
 * tears down on EOF, so this needs no framing beyond one JSON line in.
 */
function fetchCommands() {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", ["--mode", "rpc"], { stdio: ["pipe", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			settle(() => reject(new Error(`no get_commands response within ${timeoutMs}ms`)));
		}, timeoutMs);

		function settle(action) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			// RPC mode should exit on its own; make sure it does not outlive the check.
			const force = setTimeout(() => child.kill("SIGKILL"), 2000);
			force.unref?.();
			action();
		}

		child.on("error", (err) => {
			if (err.code === "ENOENT") {
				settle(() =>
					reject(new Error("`pi` is not on PATH — install it first: npm i -g @earendil-works/pi-coding-agent")),
				);
				return;
			}
			settle(() => reject(err));
		});

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			for (const line of stdout.split("\n")) {
				if (!line.trim().startsWith("{")) continue;
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue; // partial line, still streaming
				}
				if (parsed.type !== "response" || parsed.id !== REQUEST_ID) continue;
				if (!parsed.success) {
					settle(() => reject(new Error(`pi rejected get_commands: ${parsed.error ?? "unknown error"}`)));
					return;
				}
				settle(() => resolve(parsed.data.commands ?? []));
				return;
			}
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			if (settled) return;
			settle(() =>
				reject(
					new Error(
						`pi exited (code=${code}) before answering get_commands` +
							(stderr.trim() ? `; stderr:\n${stderr.trim()}` : ""),
					),
				),
			);
		});

		child.stdin.on("error", () => {}); // EPIPE if pi dies first; the close handler reports it
		child.stdin.write(`${JSON.stringify({ type: "get_commands", id: REQUEST_ID })}\n`);
		child.stdin.end();
	});
}

const commands = await fetchCommands().catch((err) => fail(err.message, 2));

if (jsonMode) {
	process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`);
	process.exit(0);
}

const problems = [];

// 0. Renamed duplicates first, so the "missing" checks below can stay quiet about a
//    command we already know was registered under a suffixed name.
const doubleLoaded = new Set();
for (const command of commands) {
	const renamed = DUPLICATE_SUFFIX.exec(command.name);
	if (!renamed) continue;
	const [, base] = renamed;
	if (EXPECTED.includes(base)) doubleLoaded.add(base);
}
for (const base of doubleLoaded) {
	const copies = commands.filter((c) => DUPLICATE_SUFFIX.exec(c.name)?.[1] === base);
	const origins = copies.map((c) => c.sourceInfo?.origin ?? "?");
	problems.push(
		`/${base} is registered ${copies.length} times (${copies.map((c) => `/${c.name} [${c.sourceInfo?.origin ?? "?"}]`).join(", ")}) — ` +
			`${copies.length} copies loaded (${origins.join(" + ")}); /${base} itself is gone`,
	);
}

// 1. Every expected command present exactly once, and sourced from the package.
for (const name of EXPECTED) {
	if (doubleLoaded.has(name)) continue; // already reported above
	const matches = commands.filter((c) => c.name === name);
	if (matches.length === 0) {
		problems.push(`missing command /${name} — the package did not load`);
		continue;
	}
	if (matches.length > 1) {
		problems.push(`/${name} registered ${matches.length} times`);
	}
	for (const match of matches) {
		const origin = match.sourceInfo?.origin;
		if (origin !== "package") {
			problems.push(`/${name} came from origin "${origin ?? "unknown"}", not "package" — is a bare checkout loading too?`);
		}
	}
}

const found = commands.filter((c) => EXPECTED.includes(c.name));

if (problems.length > 0) {
	process.stderr.write("check-commands: FAILED\n");
	for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
	process.stderr.write("\ncommands pi reported:\n");
	for (const command of commands) {
		process.stderr.write(`  /${command.name}  [${command.sourceInfo?.origin ?? "?"}]\n`);
	}
	process.exit(1);
}

process.stdout.write(`check-commands: OK — ${found.length}/${EXPECTED.length} commands, all from the package\n`);
for (const command of found) {
	process.stdout.write(`  /${command.name}  [${command.sourceInfo?.origin}]\n`);
}
