#!/usr/bin/env node
/**
 * CLI das frentes de trabalho (worktree + branch + PR) e de seus pacotes AWU.
 * Saída: uma linha JSON; `status: ok` com exit 0, `blocked`/`error` com exit 1.
 * Uso: node workspace.mjs status | start --work-item 5346 --work-item-type "User Story"
 */
import { CommandFailure, firstLine } from "./lib/git.mjs";
import { Blocked, block } from "./lib/outcome.mjs";
import { resolveContext, requireFront } from "./lib/context.mjs";
import { status } from "./lib/status.mjs";
import { start, newPackage } from "./lib/start.mjs";
import { commit } from "./lib/commit.mjs";
import { sync } from "./lib/sync.mjs";
import { finish } from "./lib/finish.mjs";
import { cleanup } from "./lib/cleanup.mjs";
import { acquireLock, releaseLock, lockHolder } from "./lib/lock.mjs";

const Target = { workspace: "value", repo: "value" };
const Commands = {
  status: { flags: { ...Target, all: "flag" }, run: (ctx, opts) => status(ctx, opts) },
  start: {
    flags: { "work-item": "value", "work-item-type": "value", title: "value", description: "value", "no-package": "flag", repo: "value" },
    run: (ctx, opts) => start(ctx, opts),
  },
  "package new": { flags: { ...Target, id: "value", description: "value" }, run: (ctx, opts) => newPackage(ctx, requireFront(ctx, opts), opts) },
  commit: {
    flags: { ...Target, message: "value", "message-file": "value", paths: "list" },
    run: (ctx, opts) => commit(ctx, requireFront(ctx, opts), opts),
  },
  sync: { flags: { ...Target, "keep-conflict": "flag", conclude: "flag" }, run: (ctx, opts) => sync(ctx, requireFront(ctx, opts), opts) },
  finish: {
    flags: { ...Target, "pr-title": "value", "pr-body-file": "value", "pr-footer": "value" },
    run: (ctx, opts) => finish(ctx, requireFront(ctx, opts), opts),
  },
  cleanup: { flags: { ...Target, confirm: "value", "dry-run": "flag" }, run: (ctx, opts) => cleanup(ctx, requireFront(ctx, opts), opts) },
  "lock acquire": {
    flags: { repo: "value", pid: "value", owner: "value" },
    run: (ctx, opts) => acquireLock(ctx.common, opts.positionals[0], { pid: holderPid(opts), owner: opts.owner }),
  },
  "lock release": { flags: { repo: "value", pid: "value" }, run: (ctx, opts) => releaseLock(ctx.common, opts.positionals[0], holderPid(opts)) },
  "lock status": { flags: { repo: "value" }, run: (ctx, opts) => ({ resource: opts.positionals[0], holder: lockHolder(ctx.common, opts.positionals[0]) }) },
};

function holderPid(opts) {
  const pid = Number(opts.pid);
  if (!Number.isSafeInteger(pid) || pid < 1) block("arguments", "--pid deve ser o pid do processo dono do recurso");
  return pid;
}

function commandName(argv) {
  const pair = `${argv[0]} ${argv[1]}`;
  if (Commands[pair]) return [pair, argv.slice(2)];
  if (Commands[argv[0]]) return [argv[0], argv.slice(1)];
  block("usage", `comando desconhecido: ${argv[0] ?? "(vazio)"}`, { commands: Object.keys(Commands) });
}

function takeValues(args, index, kind, flag) {
  if (kind === "flag") return [true, index];
  let end = index + 1;
  while (end < args.length && !args[end].startsWith("--") && (kind === "list" || end === index + 1)) end += 1;
  const values = args.slice(index + 1, end);
  if (!values.length) block("arguments", `falta valor para ${flag}`);
  return [kind === "list" ? values : values[0], end - 1];
}

function parse(argv) {
  const [command, args] = commandName(argv);
  const opts = { positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      opts.positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const kind = Commands[command].flags[key];
    if (!kind) block("arguments", `opção desconhecida para ${command}: ${token}`, { options: Object.keys(Commands[command].flags).map((name) => `--${name}`) });
    if (Object.hasOwn(opts, key)) block("arguments", `opção repetida: ${token}`);
    [opts[key], index] = takeValues(args, index, kind, token);
  }
  return { command, opts };
}

function failure(error) {
  if (error instanceof Blocked) return { status: "blocked", step: error.step, message: error.message, ...error.details };
  if (error instanceof CommandFailure) return { status: "blocked", step: "git", message: error.message, detail: firstLine(error.stderr) };
  return { status: "error", message: error.message };
}

try {
  const { command, opts } = parse(process.argv.slice(2));
  const result = await Commands[command].run(resolveContext(opts), opts);
  process.stdout.write(`${JSON.stringify({ status: "ok", command, ...result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify(failure(error))}\n`);
  process.exitCode = 1;
}
