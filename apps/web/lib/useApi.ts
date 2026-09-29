"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, userMessage } from "./api";
import {
  clearApiCache as clearScopedCache,
  getApiGeneration,
  readScopedCache,
  scopedCacheKey,
  subscribeApiGeneration,
  writeScopedCache,
} from "./api-cache";
import { useOptionalApiScope } from "./auth";

/**
 * Escopo transitório de troca de tenant (`switching:<generation>`, dono:
 * `AuthProvider`): hold síncrono — nenhuma leitura pode buscar, ler cache
 * ou expor dado nele. Local ao `useApi` (sem novo import de `auth`) para
 * não criar ciclo de módulo.
 */
function isSwitchingApiScope(scope: string): boolean {
  return scope.startsWith("switching:");
}

export interface UseApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /**
   * Erro do último `refresh` em background com dado preservado: quando há
   * dado visível, a falha do `refresh` mantém o dado e expõe aqui a
   * mensagem (sem tocar em `error`/`loading`); sem dado, a falha vai para
   * `error` e este campo segue `null`. Sucesso do `refresh`, troca de
   * scope/path e `reload` sempre limpam. A repetição (`refresh` de novo)
   * é o retry que não descarta o cache.
   */
  refreshError: string | null;
  /**
   * Revalida em background sem derrubar o dado visível nem exibir
   * skeleton: sucesso atualiza dado/cache e limpa erro e `refreshError`;
   * falha com dado visível preserva o dado e expõe só `refreshError`
   * (retry = outro `refresh()`, sem descartar o cache); falha sem dado
   * expõe `error` (401/403 sempre escondem o dado).
   * Não faz nada sem dado visível (o hard inicial é o único fetch do
   * mount sem cache). Guardas de chave completa (scope+path+nonce) e
   * geração compartilhada com o hard/`reload` descartam respostas tardias.
   */
  refresh: () => void;
}

/**
 * Hook de leitura com cache em memória isolado por identidade.
 *
 * Desvio MVP deliberado do TanStack Query — ver README (upgrade path).
 *
 * SEGURANÇA: cada entrada é chaveada por `scope + path`, onde scope =
 * user id + activeTenantId + geração não-secreta (nunca o token).
 * A troca de scope/path esconde o `data` anterior de forma síncrona no mesmo
 * render (antes dos efeitos) e respostas tardias de outra chave (scope ou
 * path antigo, ou geração de `reload` anterior) são descartadas — nunca
 * populam o estado nem o cache da requisição atual.
 */
export function useApi<T>(path: string | null): UseApiState<T> {
  const authScope = useOptionalApiScope();
  // Fallback para uso standalone sem AuthProvider: namespace
  // anônimo/público isolado, que também acompanha a geração.
  const [fallbackGeneration, setFallbackGeneration] = useState(() => getApiGeneration());
  useEffect(
    () => subscribeApiGeneration(() => setFallbackGeneration(getApiGeneration())),
    [],
  );
  const scope = authScope ?? `public:anonymous:${fallbackGeneration}`;
  // Escopo transitório de troca de tenant: hold síncrono — nunca busca, lê
  // cache ou expõe dado; só esconde o valor antigo até o commit autoritativo.
  const switching = isSwitchingApiScope(scope);

  const initial = switching
    ? { hit: false as const, value: null as T | null }
    : readScopedCache<T>(scope, path ?? "");
  const [data, setData] = useState<T | null>(path === null || switching ? null : initial.value);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!switching && path !== null && !initial.hit);
  const [nonce, setNonce] = useState(0);
  // Escopo/path vinculados ao estado visível; divergência no render
  // indica troca de identidade → esconder tudo antes dos efeitos.
  const [bound, setBound] = useState({ scope, path });

  // Refs vivas para o `refresh` estável (sem recriar a cada render).
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const pathRef = useRef(path);
  pathRef.current = path;
  const dataRef = useRef(data);
  dataRef.current = data;
  // Geração monotônica compartilhada entre hard fetch, `refresh` e `reload`:
  // só a última requisição iniciada para o `scope+path+nonce` atual pode
  // atualizar `data/error/cache`. Invalida respostas tardias hard-vs-soft em
  // qualquer direção (um `refresh` novo descarta um hard antigo pendente e
  // um hard/`reload` novo descarta um `refresh` antigo pendente).
  const reqSeq = useRef(0);

  if (bound.scope !== scope || bound.path !== path) {
    setBound({ scope, path });
    setNonce(0);
    reqSeq.current += 1;
    if (isSwitchingApiScope(scope)) {
      setData(null);
      setError(null);
      setRefreshError(null);
      setLoading(false);
    } else {
      const cached = path === null ? { hit: false, value: null } : readScopedCache<T>(scope, path);
      setData(cached.value);
      setError(null);
      setRefreshError(null);
      setLoading(path !== null && !cached.hit);
    }
  }

  // Chave da requisição atual (scope + path) e geração de reload: uma
  // resposta tardia só pode tocar o estado/cache quando ainda for a atual.
  // Só o scope não basta — a troca de path com o mesmo scope (filtro,
  // detalhe) mantém `scopeRef` e o `cancelled` do efeito anterior pode
  // ainda estar `false` entre o render síncrono e a limpeza do efeito.
  const keyRef = useRef(scopedCacheKey(scope, path ?? ""));
  keyRef.current = scopedCacheKey(scope, path ?? "");
  const nonceRef = useRef(nonce);
  nonceRef.current = nonce;

  useEffect(() => {
    if (path === null) return;
    if (isSwitchingApiScope(scope)) return;
    if (readScopedCache<T>(scope, path).hit && nonce === 0) return;
    let cancelled = false;
    const requestScope = scope;
    const requestPath = path;
    const requestKey = scopedCacheKey(requestScope, requestPath);
    const requestNonce = nonce;
    reqSeq.current += 1;
    const myReq = reqSeq.current;
    setLoading(true);
    setError(null);
    setRefreshError(null);
    apiFetch<T>(path)
      .then((result) => {
        if (cancelled) return;
        // Resposta tardia de outra chave/geração/requisição: descarta sem
        // tocar no estado nem no cache da requisição atual. O `reqSeq`
        // cobre hard-vs-soft: um `refresh` mais novo invalida este hard.
        if (keyRef.current !== requestKey || nonceRef.current !== requestNonce) return;
        if (reqSeq.current !== myReq) return;
        writeScopedCache(requestScope, requestPath, result);
        setData(result);
        setLoading(false);
        setRefreshError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (keyRef.current !== requestKey || nonceRef.current !== requestNonce) return;
        if (reqSeq.current !== myReq) return;
        setError(userMessage(err));
        setRefreshError(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, scope, nonce]);

  const reload = useCallback(() => {
    // Invalida o path em todos os escopos (callers existentes intactos).
    if (path !== null) clearScopedCache(path);
    // Invalida refreshes em voo antes do hard do novo `nonce` partir (esse
    // hard captura uma geração ainda maior e vence os anteriores).
    reqSeq.current += 1;
    setData(null);
    setRefreshError(null);
    setNonce((n) => n + 1);
  }, [path]);

  const refresh = useCallback(() => {
    const requestPath = pathRef.current;
    if (requestPath === null) return;
    if (isSwitchingApiScope(scopeRef.current)) return;
    // Sem dado visível/cached não há o que revalidar: o hard inicial é a
    // única requisição do mount sem cache. Isso remove a duplicata do
    // `NeedsAttention` (hard + soft no mount) e impede um soft órfão de
    // disputar com o hard inicial.
    if (dataRef.current === null) return;
    const requestScope = scopeRef.current;
    const requestKey = scopedCacheKey(requestScope, requestPath);
    const requestNonce = nonceRef.current;
    reqSeq.current += 1;
    const myReq = reqSeq.current;
    apiFetch<T>(requestPath)
      .then((result) => {
        if (keyRef.current !== requestKey || nonceRef.current !== requestNonce) return;
        if (reqSeq.current !== myReq) return;
        writeScopedCache(requestScope, requestPath, result);
        setData(result);
        setError(null);
        setRefreshError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (keyRef.current !== requestKey || nonceRef.current !== requestNonce) return;
        if (reqSeq.current !== myReq) return;
        // 401/403 autoritativo nunca mantém dado não autorizado visível.
        // (401 já limpou cache/geração no `apiFetch` e a troca de escopo
        // esconde o dado; 403 não avança geração, então esconde aqui.)
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          if (err.status === 403) clearScopedCache(requestPath);
          setData(null);
          setError(userMessage(err));
          setRefreshError(null);
          setLoading(false);
          return;
        }
        // Background: preserva o dado visível e expõe o erro de frescor sem
        // tocar em `error`/`loading`; só expõe erro hard quando não há dado
        // a preservar. O retry é outro `refresh()` (não descarta o cache).
        if (dataRef.current === null) {
          setError(userMessage(err));
          setRefreshError(null);
          setLoading(false);
        } else {
          setRefreshError(userMessage(err));
        }
      });
  }, []);

  return { data: switching ? null : data, error: switching ? null : error, loading: switching ? false : loading, reload, refresh, refreshError: switching ? null : refreshError };
}

/**
 * Limpeza explícita (assinatura preservada): sem `path`, esvazia tudo;
 * com `path`, invalida o path em todos os escopos.
 */
export function clearApiCache(path?: string): void {
  clearScopedCache(path);
}

export { ApiError };
