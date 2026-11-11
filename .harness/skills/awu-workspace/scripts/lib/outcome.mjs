/**
 * Falha esperada de pré-condição: vira JSON `blocked` no CLI, com a etapa e os
 * fatos necessários para decidir o próximo passo sem reexecutar.
 * Uso: block("dirty-tree", "árvore com alterações não commitadas", { files }).
 */
export class Blocked extends Error {
  constructor(step, message, details = {}) {
    super(message);
    this.name = "Blocked";
    this.step = step;
    this.details = details;
  }
}

export function block(step, message, details) {
  throw new Blocked(step, message, details);
}

/** Limita listas na saída para não gastar tokens com inventários longos. Uso: capped(files). */
export function capped(items, limit = 30) {
  return { total: items.length, items: items.slice(0, limit) };
}
