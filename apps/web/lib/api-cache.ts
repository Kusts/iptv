/**
 * Cache de leitura da web isolado por identidade de sessão.
 *
 * Módulo-folha (não importa `auth`, `useApi` nem `api`): existe para que
 * `api.ts` (401), `auth.tsx` (login/logout/troca de tenant) e `useApi.ts`
 * compartilhem o mesmo armazenamento e a mesma geração sem ciclo de imports.
 *
 * REGRA DE SEGURANÇA: a chave de cada entrada é `${scope}::${path}`, onde
 * `scope` contém apenas user id + activeTenantId + geração não-secreta.
 * O bearer token NUNCA entra na chave nem é armazenado aqui.
 */

const store = new Map<string, unknown>();

let generation = 0;

const listeners = new Set<() => void>();

/** Geração atual (não-secreta) — avança a cada transição de sessão. */
export function getApiGeneration(): number {
  return generation;
}

/** Assina avanços de geração; retorna função de unsubscribe. */
export function subscribeApiGeneration(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Avança a geração e notifica assinantes. Chamado em login, logout,
 * troca de tenant, 401 e falha de restauração de sessão, sempre junto
 * de `clearApiCache()` (limpeza total): a limpeza remove leituras que
 * uma sessão anterior possa ter deixado em qualquer escopo — inclusive
 * fetches autenticados feitos no namespace público antes da sessão
 * restaurar — e o avanço impede reutilizar o scope anterior.
 */
export function advanceApiGeneration(): number {
  generation += 1;
  for (const fn of [...listeners]) fn();
  return generation;
}

export function scopedCacheKey(scope: string, path: string): string {
  return `${scope}::${path}`;
}

export function readScopedCache<T>(scope: string, path: string): { hit: boolean; value: T | null } {
  const key = scopedCacheKey(scope, path);
  if (!store.has(key)) return { hit: false, value: null };
  return { hit: true, value: store.get(key) as T };
}

export function writeScopedCache<T>(scope: string, path: string, value: T): void {
  store.set(scopedCacheKey(scope, path), value);
}

/**
 * Limpeza explícita (comportamento preservado): sem `path`, esvazia tudo;
 * com `path`, invalida o path em TODOS os escopos para que callers
 * existentes (`clearApiCache(query)` + `reload()`) continuem funcionando.
 */
export function clearApiCache(path?: string): void {
  if (path === undefined) {
    store.clear();
    return;
  }
  const suffix = `::${path}`;
  for (const key of [...store.keys()]) {
    if (key.endsWith(suffix)) store.delete(key);
  }
}
