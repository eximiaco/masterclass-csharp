// Contrato de saída dos scripts da skill run-e2e: JSON em stdout, exit code fixo.
// 0 = suíte verde; 1 = testes falharam; 2 = erro de infra/uso (stack, runner, argumentos).
export const EXIT_PASSED = 0;
export const EXIT_TESTS_FAILED = 1;
export const EXIT_INFRA_ERROR = 2;

export const FORBIDDEN_ACTIONS = [
  "imprimir, copiar ou registrar valores de contexts/core/frontend/e2e/docker/.env (segredos); apenas nomes de chaves",
  "editar e2e/docker/.env, .env.playwright ou credenciais para fazer um teste passar",
  "alterar seed (e2e/db/seed) ou spec para mascarar divergencia que indique defeito de produto",
  "subir workers acima de 3 (Chromium cai no Docker Desktop de 8 GB e logins simultaneos falham no Keycloak HML)",
  "remover volumes do ambiente E2E (down --reset) sem pedido explicito do usuario",
  "repetir a suite mais de uma vez por falha transitoria de STG sem registrar a ocorrencia no relatorio"
];

export function emit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(exitCode);
}

export function fail(info) {
  const payload = { status: "error", ...info, forbidden_actions: FORBIDDEN_ACTIONS };
  emit(payload, EXIT_INFRA_ERROR);
}

export function log(message) {
  process.stderr.write(`[run-e2e] ${message}\n`);
}
