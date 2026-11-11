// Renderiza summary.md (pt-BR), o relatório padronizado lido por pessoas e agentes.

const VERDICT_LABEL = { passed: "PASSOU", failed: "FALHOU", "infra-error": "ERRO DE INFRA" };

function statsTable(stats) {
  return [
    "| expected | unexpected | flaky | skipped | duração | workers |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${stats.expected} | ${stats.unexpected} | ${stats.flaky} | ${stats.skipped} | ${Math.round(stats.duration_ms / 1000)} s | ${stats.workers ?? "?"} |`
  ].join("\n");
}

function failureBlock(failure, index, reproduce) {
  const lines = [`### ${index + 1}. ${failure.title}`, "", `- **Spec:** \`${failure.file}:${failure.line}\` (${failure.status}, ${failure.attempts} tentativa(s), última: ${failure.last_status})`];
  if (failure.error?.location) lines.push(`- **Local do erro:** \`${failure.error.location}\``);
  lines.push(`- **Dica (${failure.hint.category}):** ${failure.hint.action}`);
  for (const [name, path] of Object.entries(failure.attachments)) {
    if (typeof path === "string") lines.push(`- **${name}:** \`${path}\``);
  }
  lines.push(`- **Reproduzir:** \`${reproduce(failure)}\``);
  if (failure.error?.message) lines.push("", "```text", failure.error.message, "```");
  if (failure.stderr_tail.length) lines.push("", "stderr (final):", "```text", ...failure.stderr_tail, "```");
  return lines.join("\n");
}

function logsBlock(logs) {
  const parts = [];
  for (const [service, info] of Object.entries(logs)) {
    parts.push(`### ${service}`, "", `- arquivo completo: \`${info.file}\``, `- linhas relevantes: ${info.highlights.total_matches}${info.window ? ` (janela ${info.window.since} → ${info.window.until})` : ""}`);
    if (info.highlights.lines.length) parts.push("", "```text", ...info.highlights.lines, "```");
    parts.push("");
  }
  return parts.join("\n");
}

export function renderSummary(report) {
  const r = report;
  const reproduce = (failure) => `node .harness/skills/run-e2e/scripts/run-e2e.mjs ${failure.file.replace(/^.*\/contexts\/core\/frontend\//, "")} --no-stack --keep-stack`;
  const sections = [
    `# Execução E2E — ${r.run_id}`,
    "",
    `**Veredito:** ${VERDICT_LABEL[r.verdict] ?? r.verdict}`,
    "",
    `- Branch/commit: \`${r.git.branch}\` @ \`${r.git.head}\``,
    `- Alvos: ${r.targets.length ? r.targets.map((t) => `\`${t.path}\``).join(", ") : "suíte completa"}`,
    `- Argumentos do Playwright: \`${r.playwright_args.join(" ") || "(nenhum)"}\``,
    `- Stack: ${r.stack.mode}${r.stack.db_mode ? ` (db: ${r.stack.db_mode})` : ""}${r.stack.up_seconds != null ? `, subida em ${r.stack.up_seconds} s` : ""}`,
    `- Teardown: ${r.teardown.performed ? r.teardown.status : "não executado"}${r.teardown.reason ? ` (${r.teardown.reason})` : ""}`,
    ""
  ];
  if (r.stats) sections.push("## Estatísticas", "", statsTable(r.stats), "");
  if (r.run_errors?.length) sections.push("## Erros do runner", "", "```text", ...r.run_errors, "```", "");
  if (r.failures?.length) {
    sections.push("## Falhas", "");
    r.failures.forEach((f, i) => sections.push(failureBlock(f, i, reproduce), ""));
  }
  if (r.infra_error) sections.push("## Erro de infra", "", `- Etapa: \`${r.infra_error.step}\``, `- Mensagem: ${r.infra_error.message}`, r.infra_error.command ? `- Comando: \`${r.infra_error.command}\` (exit ${r.infra_error.exit_code})` : "", "", "```text", ...(r.infra_error.stderr_tail ?? []), "```", "");
  if (r.logs && Object.keys(r.logs).length) sections.push("## Logs da stack", "", logsBlock(r.logs));
  if (r.diagnostics) sections.push("## Diagnóstico (OTel e login)", "", `- telemetria OTLP (traces, logs, métricas em JSONL): \`${r.diagnostics.otel_dir}\``, `- login por worker (linha do tempo; em falha, trace, screenshot e HTML): \`${r.diagnostics.login_dir}\``, ...r.diagnostics.login_failures.map((n) => `- login com falha: \`${n}\``), "");
  sections.push("## Artefatos", "", ...Object.entries(r.artifacts).map(([k, v]) => `- ${k}: \`${v}\``), "");
  sections.push("## Próximos passos", "", ...r.next_steps.map((s) => `- ${s}`), "");
  return sections.join("\n");
}
