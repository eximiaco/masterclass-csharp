/** Projeta saída sem modificar registro ou critérios. Uso: summarizeResult(registry). */
export function summarizeResult(result) {
  if (!Array.isArray(result)) return summarizeRegistry(result);
  return {
    executions: result.length,
    closed: result.filter((registry) => registry.status === "closed").length,
    pending: result.filter((registry) => registry.status !== "closed").map(summarizeRegistry),
    detail_command: "status --all (sem --summary)",
  };
}

function summarizeRegistry(registry) {
  return {
    execution_id: registry.execution_id,
    feature: registry.feature,
    registry: `.harness/workspace/test-lifecycle/${registry.execution_id}/temporary-tests.json`,
    status: registry.status,
    blocked_reason: registry.blocked_reason ?? null,
    entries: registry.entries.length,
    states: Object.fromEntries([...new Set(registry.entries.map((entry) => entry.status))]
      .map((status) => [status, registry.entries.filter((entry) => entry.status === status).length])),
    paths: registry.entries.map((entry) => entry.path),
    pending: registry.entries.filter((entry) => entry.status !== "removed")
      .map((entry) => ({ id: entry.id, owner: entry.owner, status: entry.status, expiration: entry.expiration })),
    evidence: registry.archive?.directory ?? registry.validation?.source ?? null,
    closure_pending: registry.status !== "closed",
  };
}
