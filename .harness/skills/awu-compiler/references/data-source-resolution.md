# Persisted data decisions

Read only when reading/writing/filtering/aggregating/migrating persisted data.

#### Data source cascade

When the change reads, writes, filters, aggregates, or migrates persisted data,
schema facts and SQL must be verified, not inferred.

`.harness/data-sources.yaml` declares which databases may be consulted and maps
the generic capabilities below to concrete MCP servers and tools. Refer to
servers only through the aliases declared there. Never read, copy, or emit
connection strings or credentials.

| Capability | Purpose |
|---|---|
| `verify_identity` | Confirm the connected database equals `expected_database` |
| `introspect_schema` | Tables, views, columns, types, nullability, indexes, constraints, triggers, enums |
| `read_routines` | Definitions of functions and procedures the change touches or depends on |
| `read_query` | Execute read-only queries to validate filters, joins, cardinality, and result shape |
| `explain` | Plan-only validation of DML/DDL and query plans |

Cascade:

1. Select the sources whose `covers` intersects the paths affected by the change.
   If none applies, skip the cascade.
2. When `consent` is `ask`, ask the human once per compilation before the first
   call. Without consent, go to step 5.
3. Run `verify_identity`. If the database differs from `expected_database`,
   stop and report; do not query a different database.
4. Use the capabilities required by the change. Prefer validating the exact SQL
   that the Agent Work Unit will fix as a decision.
5. If the source is unavailable, show its `on_unavailable_hint` and wait for the
   human. If it remains unavailable, derive facts from `schema_authority` in code
   and label them `code-derived`.
6. If facts remain ambiguous, ask. Never infer schema or routine behavior.

Safety rules:

- Use only the tools and operations listed in the source's `capabilities`.
  Never call mutation tools or operations, even inside a transaction.
- Validate DML/DDL only with `explain` and `analyze: false`.
- Respect the source's `limits` on every call.
- Never copy row values into Agent Work Units, the execution manifest, or
  diagnostics. Record schema, routine signatures, counts, and result shape only.

Authority: migrations and entity configurations declared in `schema_authority`
outrank the live database. When the live schema diverges from them, record the
divergence and resolve it with the human before emission; the live database
never silently overrides code.

The execution agent must not depend on the data source. Verified facts and
validated SQL decisions are embedded in the Agent Work Unit.

