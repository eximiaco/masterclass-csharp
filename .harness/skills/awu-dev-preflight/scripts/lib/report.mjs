export const FORBIDDEN_ACTIONS = [
  "descartar alteracoes locais: git checkout/restore -- <path>, git reset --hard, git restore --staged seguido de descarte",
  "remover arquivos nao rastreados: git clean",
  "excluir branch: git branch -D, git branch -d, git push origin --delete",
  "sobrescrever historico: git push --force, git push --force-with-lease, git rebase destrutivo",
  "reescrever historico: git filter-branch, git filter-repo",
  "apagar ou sobrescrever .harness/project-profile.yaml ou artefatos do workspace do usuario"
];

export function reportOk(payload) {
  process.stdout.write(JSON.stringify({ status: "ok", ...payload }, null, 2) + "\n");
  process.exit(0);
}

export function fail(info) {
  const payload = { status: "error", ...info, forbidden_actions: FORBIDDEN_ACTIONS };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(1);
}
