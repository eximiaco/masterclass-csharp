// Execução de processos: stdout dos filhos vai para stderr (o stdout deste CLI é só o JSON final).
import { spawn, spawnSync } from "node:child_process";

export function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function tail(text, lines = 40) {
  const all = stripAnsi(text).split("\n").filter((line) => line.trim() !== "");
  return all.slice(-lines);
}

// Saída máxima capturada por runSync. O padrão do Node (1 MB) cortava em silêncio o `docker compose logs` do
// shell-bff (log de debug passa de 1 MB numa suíte), e o arquivo salvo parecia completo.
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

// Roda e espera; captura stdout/stderr sem ecoar (comandos curtos: git, docker compose ps/logs).
export function runSync(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: MAX_CAPTURE_BYTES });
  return {
    command: [command, ...args].join(" "),
    exit_code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
}

// Roda, ecoa a saída em stderr enquanto executa e captura tudo (comandos longos: up.sh, run.sh).
export function runStreaming(command, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stderr.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", (error) => resolve({ command: [command, ...args].join(" "), exit_code: -1, stdout, stderr, error: error.message }));
    child.on("close", (code) => resolve({ command: [command, ...args].join(" "), exit_code: code ?? -1, stdout, stderr }));
  });
}

export function commandAvailable(command, args = ["--version"]) {
  const result = runSync(command, args);
  return result.exit_code === 0;
}
