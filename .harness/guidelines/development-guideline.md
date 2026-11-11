# Coding Practices

> **Scope.** This document governs how you **write code** — nothing else.
> Load and apply it only when the task is to create, modify, or refactor
> source code. It does not apply to research, planning, writing prose,
> answering questions, or running read-only commands.
>
> **Precedence.** A repository's own conventions (its `CLAUDE.md`, style
> config, existing patterns) win over this document when they conflict.
> These rules are the default, not an override.
>
> **Language-agnostic.** Rules are stated for any language. Where a rule
> names a concrete tool, treat it as the example for *that* ecosystem and
> apply the equivalent in the language at hand.

## First, read before you write
- Read the surrounding code before adding to it. Match the file's
  existing style, naming, and structure — don't impose a new one.
- Find the pattern already used for this kind of problem and follow it.
  Introducing a second way to do the same thing is a cost, not a feature.
- Prefer the smallest change that solves the problem. A large diff must
  be justified by the task, not by your preference for how code "should"
  look.
- Don't rename, reformat, or restructure code unrelated to the task.
  Keep the diff reviewable.

## Backward compatibility is opt-in, never assumed
- Do **not** preserve, infer, or invent backward compatibility unless the
  task explicitly asks for it. It is not a default.
- With no explicit instruction, make the clean change: rename freely,
  drop the old signature, delete the dead path, migrate the callers.
- Don't add compatibility shims, aliases, deprecation wrappers, dual
  code paths, version flags, or "legacy" fallbacks on your own initiative.
- If you believe compatibility genuinely matters here, stop and ask —
  don't decide it silently.
- When the task *does* require it, treat it as an explicit contract:
  state what is kept compatible and why, right where the code lives.

## Code style
- Functions: 4-20 lines. Split if longer.
- Files: under 500 lines. Split by responsibility.
- One thing per function, one responsibility per module (SRP).
- Early returns over nested ifs. Max 2 levels of indentation.
- No dead code. Don't leave commented-out blocks "just in case" — that's
  what version control is for.
- No code duplication. Extract shared logic into a function/module once
  it appears a third time (rule of three).
- Keep public surface small. Export only what callers need; keep the
  rest private/internal.

## Naming
- Specific and unique. Avoid `data`, `info`, `handler`, `Manager`,
  `util`, `tmp`, `obj`.
- Prefer names that return <5 grep hits in the codebase — a name you can
  find is a name you can maintain.
- Booleans read as predicates: `isReady`, `hasToken`, `shouldRetry`.
- Functions are verbs (`ResolveStack`), values are nouns (`stackName`).
- Match the domain vocabulary the rest of the codebase already uses.

## Types & contracts
- Types explicit at boundaries. No `any`, no untyped public function,
  no bare `dict`/`map` where a named shape belongs — **in dynamic
  languages** (TypeScript, Python, etc.). In **statically typed
  languages** (C#, etc.), prefer `var`/inference at the call site and
  let the compiler derive the type; reserve explicit type annotations
  for boundaries, public APIs, and cases where inference is ambiguous
  or widens to an unwanted type.
- Make illegal states unrepresentable: prefer enums/unions/tagged types
  over stringly-typed flags.
- Validate input at the edge (parse, don't scatter checks). Once inside,
  trust your own types.
- Return values over out-parameters and mutation of caller-owned data.

## Error handling
- Fail fast and loud. Don't swallow errors or return a sentinel that
  hides the failure.
- Never catch-all silently. If you catch, either handle meaningfully or
  re-raise with context added.
- Error messages must include the offending value and the expected shape
  — enough to debug without a reproduction.
- Don't use exceptions for normal control flow.
- Clean up resources deterministically (DOTNET / `dispose` / `finally` /.
  No leaked handles, sockets, or temp files.

## Comments
- Keep existing comments. Don't strip them on refactor — they carry
  intent and provenance.
- Write WHY, not WHAT. Skip `// increment counter` above `i++`.
- Docstrings on public functions: intent + one usage example.
- Reference issue numbers / commit SHAs when a line exists because of a
  specific bug or upstream constraint.
- A comment that explains confusing code is a hint to simplify the code.

## Tests
- Tests run with a single command (project-specific). Know it before you
  start and run it before you call the work done.
- Every new function gets a test. Every bug fix gets a regression test
  that fails before the fix and passes after.
- Test behavior and contracts, not implementation details.
- Cover the edges: empty, null, boundary, and the error paths — not just
  the happy path.
- Mock external I/O (network, DB, filesystem, clock) with named fakes,
  not inline stubs.
- Tests are F.I.R.S.T: Fast, Independent, Repeatable, Self-validating,
  Timely. No shared mutable state or ordering dependency between tests.
- For unit tests use triple AAA (arrange, act, assert).

## Dependencies
- Inject dependencies through constructor/parameter.
- Wrap third-party libs behind a thin interface owned by this project,
  so a swap touches one file.
- Don't add a dependency for something small you can write in a few
  lines. Every dependency is a liability.
- Prefer the standard library and what's already vendored before pulling
  in something new.
- Pin/lock versions. Reproducible builds over "latest".

## Structure
- Follow the framework's convention (.NET, Python, Next.js, etc.).
- Prefer small focused modules over god files.
- Predictable paths: controller/model/view, src/lib/test, etc.
- Dependencies point one direction. No import cycles.
- Keep business logic free of framework and I/O concerns so it stays
  testable in isolation.

## Security
- Never hardcode secrets, tokens, or credentials. Read them from the
  environment or a secret store, and never log them.
- Treat all external input as untrusted: validate, escape, parameterize.
  No string-built SQL, shell, or HTML.
- Least privilege for every file, mount, socket, and network call.
- Don't weaken an existing security control to make a feature work —
  flag the conflict instead.

## Concurrency
- Prefer immutability and message-passing over shared mutable state.
- Guard shared state explicitly; make the locking strategy obvious.
- Every async/spawned task has a defined lifecycle — no fire-and-forget
  that can leak or outlive its owner.
- Make timeouts and cancellation explicit for anything that waits.

## Formatting
- Use the language default formatter (`gofmt`, `cargo fmt`, `prettier`,
  `black`, `shfmt`). Don't hand-format or argue style
  beyond that.
- Run the linter and fix what it flags before finishing.

## Logging
- Logging is part of the code, not an afterthought. Instrument as you
  build so the running system's behavior is observable — what it's
  doing, what it decided, and why it failed.
- Structured logging always: JSON with stable keys, not interpolated
  prose. Attach context as fields (ids, durations, outcomes) so logs are
  queryable, not just readable.
- Plain text only for user-facing CLI output — that is not logging.
- Always respect log level. Emit at the level that matches the event and
  keep the levels meaningful:
  - `error`: an actionable failure — something a human must look at.
  - `warn`: recovered or degraded, worth noticing.
  - `info`: significant state changes and boundary crossings.
  - `debug`: detail for diagnosis, off in production.
- Log at boundaries and decisions (requests, spawns, retries, failures),
  not inside tight loops. Don't drown signal in noise.
- Never log secrets, tokens, full request bodies, or PII.
- Make failures explain themselves: log the offending value and context
  alongside the error, so a log line is enough to start debugging.

## Version control
- Small, coherent commits — one logical change each.
- Follow the repo's commit-message convention (format, language, scope,
  trailers). Match what's already there.
- Don't commit generated artifacts, secrets, or unrelated churn.

## Before you call it done
- Run the formatter, the linter, and the full test suite. All green.
- Re-read your own diff as a reviewer would. Remove debug prints, TODOs
  you just introduced, and anything unrelated to the task.
- Confirm you didn't break a public contract or an existing test.
- Every API, flag, or file you reference must actually exist — verify,
  don't assume.
