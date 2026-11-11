# Conditional compilation details

Read sections relevant to decomposition, diagnostics or memory promotion. Formats
live only in templates; this reference does not define a second schema.

### Diagnostics

Every execution manifest must contain a `diagnostics` section recording the
compiler's reasoning about the Agent Work Unit package.

The section is guided and bounded:

- `decomposition`: why the package has this topology;
- `couplings`: shared surfaces detected between Agent Work Units and how the
  compilation handled them;
- `rejected_alternatives`: decompositions considered and discarded, with the
  reason;
- `execution_risks`: known execution or parallelism risks that reviewers and
  executors should be aware of;
- `data_sources`: per consulted source, `<source id>: verified | degraded |
  not_used` with a short reason (for example, consent denied or unavailable).

Every entry has at most 240 characters. `decomposition` requires at least one
entry. The other keys accept an empty list only when the compilation genuinely
has nothing to record.

`diagnostics` describes the compilation process. It must not duplicate the
review manifest, which is a consolidated human-oriented view of the emitted
specifications.

`diagnostics` is ephemeral: it is removed together with the execution
manifest, must never be treated as authoritative documentation of current
system behavior, and does not replace the learning and memory workflow
defined by `AGENTS.md`.

## Work classification

The `awu-compiler` defines the type of work required by each Agent Work Unit.

A specification describes work and required capabilities. It must not select
a concrete agent, harness, model, or execution implementation.

Use:

`work_type: <type>`

Do not use:

- `agent`
- `agent_name`
- `model`
- `harness`
- tool-specific executor identifiers

The orchestration layer is responsible for resolving `work_type` into the
appropriate execution workflow and agent.

Examples:

- `development`
- `integration-testing`
- `code-review`
- `troubleshooting`
- `documentation`

Create a separate Agent Work Unit when a required activity represents an independent
execution responsibility with its own objective and completion criteria.

Do not create an Agent Work Unit for an activity that is an automatic stage of the
orchestration workflow and does not represent independent product or
engineering work.

For example, code review, PR creation, or merge should not become separate
Agent Work Units when they are deterministic stages automatically applied to another
work type.

Create a separate Agent Work Unit only when the activity has an independent
objective, scope, and verifiable completion state.

## Agent Work Unit traceability

An Agent Work Unit identifier exists to coordinate temporary execution artifacts.

Specification identifiers must not be persisted in production source code as a
general traceability mechanism.

Do not add comments such as:

```text
// USER-AUTH-API
// Implements user-auth-api
// Generated from user-auth-api
```

Do not name production classes, functions, modules, fields, database objects,
or domain concepts after Agent Work Unit identifiers.
The implemented code must remain understandable from:

- domain concepts;
- source code;
- tests;
- contracts;
- authoritative documentation;

without requiring access to the ephemeral Agent Work Unit.

If an implementation introduces a durable and non-obvious constraint, document
the constraint itself in the appropriate authoritative location rather than
documenting the Agent Work Unit identifier.

Version-control metadata may reference an Agent Work Unit identifier temporarily when
useful for execution correlation.

No persistent project artifact should require the Agent Work Unit identifier to be
understood after the Agent Work Unit has been removed, unless that identifier is
owned by an external authoritative work-tracking system.

## Memory integration

The `awu-compiler` consumes project memory but should not blindly copy memory into specifications.

Treat the memory structure defined by `AGENTS.md` as closed. Never emit or
specify the creation of an additional memory file directly under
`.harness/memory`.

Use memory to:

- discover known constraints;
- avoid repeating previously identified mistakes;
- identify relevant procedures;
- identify project-specific conventions not obvious from the current task.

Before using a memory-derived fact, verify it against higher-authority project sources when feasible.

An Agent Work Unit may reference semantic memory or a procedure when the referenced information is stable and available to the execution agent.

Critical behavior required for successful execution should be made explicit in the Agent Work Unit rather than relying solely on optional episodic memory retrieval.

### Episodic memory

Consult episodic memory selectively when:

- a previous implementation affected the same component;
- a previous failure is relevant to the requested change;
- historical context explains a non-obvious constraint.

Episodic memory may preserve lessons from previous implementations, but it must
not attempt to reconstruct or preserve historical Agent Work Unit specifications.

The compiler must not require historical Agent Work Units to interpret episodic
memory or determine current system behavior.

Current behavior must always be established from the current system state.

Do not make execution dependent on discovering an unspecified episode.

If an episodic learning is essential for the new implementation, promote the relevant knowledge into the Agent Work Unit or appropriate semantic/procedural memory.

## Learning from Agent Work Unit execution

Execution feedback is an input to future specification quality.

When an Agent Work Unit causes an execution agent to require significant inference, clarification, rework, or correction, evaluate whether the failure reveals:

- missing specification context;
- missing acceptance criteria;
- hidden dependency;
- incorrect decomposition;
- missing project memory;
- missing procedure;
- ambiguous implementation contract.

Relevant lessons should enter the memory lifecycle defined by `AGENTS.md`.

The goal is not only for implementations to improve over time.

The **specification process itself must compound knowledge**.

