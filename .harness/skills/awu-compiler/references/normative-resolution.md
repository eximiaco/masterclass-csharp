# Normative resolution

Read when architectural patterns/conventions require resolution or MCP degrades.

#### Normative harness cascade (Playbook-first)

Before concluding architectural patterns from code alone, consult the normative
harness. Use only the canonical tool names — never harness-specific prefixes,
URLs, or credentials:

1. `arch.architecture_health` — if the server is unavailable or in hard
   `error`, record the degradation and continue the cascade; do not invent
   norms.
2. `arch.find_playbooks` with the change objective and `project_context`
   derived from `.harness/project-profile.yaml` (languages, frameworks,
   repository name) when present.
3. On `matched` → `arch.get_playbook_context` with the selected playbook id.
4. On `ambiguous` → present candidates to the human; do not choose silently.
5. On `partial` / `not_covered` → `arch.search_governance` as the only
   explicit MCP fallback; then `arch.get_artifact` when an id is already known
   (`PB-…`, `GL-…`, `GR-…`, `ADR-…`).

Cascade levels when MCP does not cover the change:

```text
MCP arch.* (Playbook-first)
  ↓ not_covered / offline / degraded
corpus on disk (if accessible in the environment)
  ↓ nothing found
repeated patterns in code (declare as local inference)
  ↓ ambiguous
declare a normative gap and ask — do not invent the norm
```

The harness prescribes. Divergence between the norm and current code is a
**conformity gap**, not a reason to lower the norm — unless an ADR with
`scope: repository` documents an intentional exception.

#### Conformity gap protocol

A conformity gap (norm ≠ code) is distinct from a **normative gap** (harness
does not cover the change / `not_covered`). Normative gaps still require asking
the human — do not invent the norm.

Conformity gaps are owned by the **compiler** during Collect/Resolve — never by
the execution agent. The executor must not create non-conformity documents.

| Situation | Who acts | Action |
|---|---|---|
| Norm ≠ code on the touched path | Compiler | Persist the gap (path below); close a decision in the AWU (align touched work / out-of-scope legacy / ask human if blocked) |
| Norm ≠ code off the touched path | Compiler | Do not expand scope; do not “fix the repo” |
| Intentional exception | Compiler | Only if an ADR with `scope: repository` exists — cite its id; do not create a gap |
| Norm absent (`not_covered`) | Compiler | Normative gap — ask the human; not a conformity gap |

**Persistence:** write a Markdown report at
`.harness/reports/conformity-gaps/<YYYY-MM-DD>-<NN>/gap.md` (new directory per
report; do not overwrite history). Do **not** write gaps into `.harness/memory/`.

**Default action when a gap intersects the change:** align *new/touched* work to
the norm; leave divergent legacy **out of scope** with an explicit decision; if
the gap blocks the change (norm cannot be met without broad refactor), **stop
and ask** — never delegate that choice to the executor.

**Rules:**

- A gap does not lower the norm and does not authorize future agents to diverge.
- Gap reports must not enter default Collect and are not soft norms.
- Do not inject the gap report (or long gap narrative) into the Agent Work Unit.
  At most one Scope line may point at the report path when it constrains the unit.

