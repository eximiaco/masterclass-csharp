// Coleta e filtra logs da stack E2E na janela de execução dos testes.
import { stripAnsi } from "./shell.mjs";

export const DEFAULT_LOG_SERVICES = ["shell-bff", "core-api"];
const MAX_HIGHLIGHTS = 60;
const WINDOW_MARGIN_MS = 10_000;

const INCLUDE_RE = /responded [45]\d\d|\b(?:4\d\d|5\d\d)\b.*\b(?:GET|POST|PUT|PATCH|DELETE)\b|\b(?:GET|POST|PUT|PATCH|DELETE)\b.*\b(?:4\d\d|5\d\d)\b|error|exception|fail|unhandled|logout|GetUser|Tenant not found|Unauthorized|crit/i;
// Healthcheck do compose bate em GET /auth/user a cada 5 s sem sessão: ruído, não evidência.
// Mantém `/auth/user responded 5xx` e qualquer falha fora desse padrão.
const EXCLUDE_RE = /\/auth\/user.*(?:\b401\b|null null)|Execut(?:ing|ed) endpoint 'HTTP: GET \/auth\/user'|GetUser: request started\. IsAuthenticated: False|GetUser Unauthorized: not authenticated/;

export function filterHighlights(text, max = MAX_HIGHLIGHTS) {
  const lines = stripAnsi(text).split("\n").filter((line) => INCLUDE_RE.test(line) && !EXCLUDE_RE.test(line));
  return { total_matches: lines.length, lines: lines.slice(-max) };
}

export function logsWindow(stats) {
  if (!stats.start_time) return null;
  const start = new Date(stats.start_time).getTime();
  const end = start + (stats.duration_ms ?? 0);
  return { since: new Date(start - WINDOW_MARGIN_MS).toISOString(), until: new Date(end + WINDOW_MARGIN_MS).toISOString() };
}

export function parseServiceList(raw) {
  return String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
