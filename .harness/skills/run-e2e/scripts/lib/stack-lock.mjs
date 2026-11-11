import { acquireLock, releaseLock } from "../../../awu-workspace/scripts/lib/lock.mjs";
import { commonRepoRoot } from "../../../awu-workspace/scripts/lib/git.mjs";

const Resource = "e2e-stack";

/**
 * A stack Docker do E2E é única na máquina: frentes em worktrees diferentes não
 * podem subir, usar ou derrubar a stack ao mesmo tempo. O lock fica na raiz comum
 * do repositório, vale enquanto o processo dono vive e é liberado na saída dele.
 * Uso: holdStackLock(REPO_ROOT) — lança `lock-busy` com `details.holder` quando outra frente usa a stack.
 */
export function holdStackLock(repoRoot, pid = process.pid) {
  const root = commonRepoRoot(repoRoot) ?? repoRoot;
  acquireLock(root, Resource, { pid, owner: repoRoot });
  process.once("exit", () => {
    try {
      releaseLock(root, Resource, pid);
    } catch {
      // Outro dono assumiu depois da recuperação: não há lock próprio a liberar.
    }
  });
}
