"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  advanceApiGeneration,
  clearApiCache,
  getApiGeneration,
  subscribeApiGeneration,
} from "./api-cache";
import {
  api,
  ApiError,
  broadcastSessionSignal,
  clearToken,
  getToken,
  isTenantContextConflict,
  SESSION_SIGNAL_KEY,
  setTenantContextConflictHandler,
  setTenantContextRevision as setCurrentTenantContextRevision,
  setToken,
  TOKEN_KEY,
  type LoginResponse,
  type MeResponse,
  type SessionResponse,
  type SwitchTenantResponse,
  type TenantsResponse,
} from "./api";

interface AuthState {
  token: string | null;
  user: { id: string; email: string; displayName: string | null } | null;
  activeTenantId: string | null;
  tenants: TenantsResponse["memberships"];
  permissions: string[];
  loading: boolean;
  /**
   * Revisão autoritativa corrente do contexto de tenant (string decimal,
   * nunca número). Comitada somente junto de um par sessão+me consistente;
   * `null` quando anônimo ou ainda não restaurado.
   */
  tenantContextRevision: string | null;
  /**
   * Escopo do cache de leitura: `auth:<userId>:<tenantId>:<revision>:<generation>`
   * ou `public:<generation>` quando deslogado. Contém apenas ids
   * não-secretos — nunca o bearer token. A revisão monotônica torna o
   * ciclo A→B→A seguro: o retorno a A chega com revisão nova, nunca
   * reutilizando o cache do A antigo.
   */
  apiScope: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

async function refreshSession(
  token: string,
  maxSnapshots = 2,
): Promise<{
  session: SessionResponse;
  me: MeResponse | null;
}> {
  let lastMismatch: ApiError | null = null;
  for (let attempt = 0; attempt < maxSnapshots; attempt += 1) {
    // Bootstrap: descobre a sessão autoritativa sem precondicionante — é
    // desta resposta que sai a revisão esperada da tentativa.
    const session = await api.get<SessionResponse>("/v1/auth/session", {
      token,
      tenantContextRevision: null,
    });
    // Sessão sem tenant ativo é coerente por si só: `activeTenantId === null`
    // não tem escopo `/me` legítimo (usuário sem membership para listar ou
    // escolher). Retorna sem chamar `/v1/me` — `me:null` aqui significa
    // ausência de escopo, nunca snapshot parcial.
    if (session.activeTenantId === null) return { session, me: null };
    let me: MeResponse | null = null;
    try {
      // Vincula `/v1/me` exatamente à revisão do snapshot acima (valor
      // capturado da resposta — nunca a revisão mutável corrente).
      me = await api.get<MeResponse>("/v1/me", {
        token,
        tenantContextRevision: session.tenantContextRevision,
        notifyContextConflict: false,
      });
    } catch (err) {
      // 401 de `/v1/me` é autoritativo: o token capturado foi invalidado e o
      // `apiFetch` já limpou o armazenamento/geração. Tratar como
      // permissões vazias aqui cometeria identidade sem credencial válida.
      if (err instanceof ApiError && err.status === 401) throw err;
      // 409 de contexto: o snapshot envelheceu entre os dois GETs (outra
      // aba/sessão trocou o tenant). Retry limitado dentro dos snapshots;
      // na última tentativa propaga para fail-closed no chamador — nunca
      // comete par parcial com revisão vencida.
      if (isTenantContextConflict(err)) {
        lastMismatch = err as ApiError;
        if (attempt === maxSnapshots - 1) throw err;
        continue;
      }
      // `/me` indisponível (rede/5xx/4xx não-401) com tenant ativo não-nulo:
      // tenta um par fresco (máx. 2 snapshots). Na última tentativa lança
      // sessão/contexto indisponível para fail-closed no chamador — nunca
      // retorna `me:null` com tenant ativo (cometeria sessão sem permissões
      // confiáveis). Só sessão sem tenant (`activeTenantId === null`, já
      // retornada acima) pode carregar `me:null` coerente.
      if (attempt === maxSnapshots - 1) {
        throw new ApiError(503, "SESSION_UNAVAILABLE", messageFor503());
      }
      continue;
    }
    // Ambos existem: nunca cometer snapshot misto de tenants/usuários
    // diferentes (troca concorrente entre os dois GETs). Retry limitado.
    if (me !== null && (session.user.id !== me.user.id || session.activeTenantId !== me.activeTenant.id)) {
      lastMismatch = new ApiError(409, "SESSION_MISMATCH", "Sessão inconsistente. Entre novamente.");
      if (attempt === maxSnapshots - 1) throw lastMismatch;
      continue;
    }
    return { session, me };
  }
  if (lastMismatch !== null) throw lastMismatch;
  throw new ApiError(503, "SESSION_UNAVAILABLE", messageFor503());
}

function messageFor503(): string {
  return "Serviço temporariamente indisponível. Tente novamente em instantes.";
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * Falha definitiva sem mutação do `TenantsController.switch`: 400/403/404
 * são rejeitados antes de `setActiveTenant` (tenant inexistente, sem
 * membership ativo ou corpo inválido) — o servidor segue no tenant antigo e
 * a sessão corrente confirmada pode ser restaurada. O 409 com
 * `code === "TENANT_SWITCH_CONFLICT"` (compare-and-set rejeitado antes de
 * qualquer mutação) ou `code === "TENANT_CONTEXT_CONFLICT"` (guard de
 * precondição rejeitado antes do controller) também é definitivo, mas SOMENTE
 * quando o status HTTP é 409: a troca pedida nunca foi aplicada e o vencedor
 * concorrente permanece ativo — o refresh autoritativo abaixo reconcilia esse
 * tenant sem fail-closed. O código no corpo com outro status (ex.: 500 com
 * `TENANT_CONTEXT_CONFLICT`) NÃO é definitivo — é ambíguo (ver abaixo).
 * Qualquer outro status
 * (rede `0`, `5xx`, `409` genérico sem esses códigos, `422/429/…` ou erro
 * não-`ApiError`) é ambíguo: um refresh imediato dizendo "ainda no tenant
 * antigo" NÃO prova ausência de efeito, pois o POST pode concluir no
 * servidor depois.
 */
function isDefiniteSwitchNoEffect(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 400 || err.status === 403 || err.status === 404) return true;
  if (err.status !== 409) return false;
  return err.code === "TENANT_SWITCH_CONFLICT" || err.code === "TENANT_CONTEXT_CONFLICT";
}

function tenantSwitchConflict(): ApiError {
  return new ApiError(
    409,
    "TENANT_SWITCH_CONFLICT",
    "O tenant ativo foi alterado em outra sessão. Exibindo o tenant atual.",
  );
}

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<AuthState["user"]>(null);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantsResponse["memberships"]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Troca de tenant em voo: muda o `apiScope` para um namespace transitório
  // (`switching:<gen>`) de forma síncrona no mesmo tick do `loading=true`,
  // escondendo leituras antigas do `useApi` mesmo sem `Shell` (o `Shell` já
  // esconde os filhos quando `loading=true`). Não avança a geração aqui para
  // não causar duplo avanço no 401 (o `apiFetch` já avança uma vez).
  const [tenantSwitching, setTenantSwitching] = useState(false);
  // Revisão autoritativa corrente do contexto (espelho em estado da revisão
  // em módulo lida pelo `apiFetch`; ambas sempre atualizadas juntas).
  const [tenantContextRevision, setTenantContextRevisionState] = useState<string | null>(null);
  // Reconciliação de 409 `TENANT_CONTEXT_CONFLICT`: hold transitório como o
  // da troca (esconde leituras sem disparar fetch com revisão vencida).
  const [contextReconciling, setContextReconciling] = useState(false);
  // Geração de restauração/sincronização de sessão: respostas tardias de
  // uma geração antiga nunca sobrescrevem a identidade mais nova.
  const sessionSeq = useRef(0);
  // Dedupe síncrono da reconciliação (notificações 409 concorrentes).
  const reconcilingRef = useRef(false);
  // Espelho do hold de troca para o reconciliador estável (sem recriá-lo).
  const switchingRef = useRef(false);
  // Geração não-secreta do escopo: avança em login/logout/troca/401.
  const [generation, setGeneration] = useState(() => getApiGeneration());

  useEffect(() => subscribeApiGeneration(() => setGeneration(getApiGeneration())), []);

  switchingRef.current = tenantSwitching;

  /**
   * Comita/limpa a revisão nos dois espelhos (módulo do `apiFetch` + estado
   * do escopo) no mesmo tick — nunca um sem o outro.
   */
  const commitRevision = useCallback((revision: string | null) => {
    setCurrentTenantContextRevision(revision);
    setTenantContextRevisionState(revision);
  }, []);

  const apiScope = useMemo(
    () =>
      tenantSwitching || contextReconciling
        ? `switching:${generation}`
        : user !== null
          ? `auth:${user.id}:${activeTenantId ?? "-"}:${tenantContextRevision ?? "-"}:${generation}`
          : `public:${generation}`,
    [user, activeTenantId, tenantContextRevision, generation, tenantSwitching, contextReconciling],
  );

  useEffect(() => {
    sessionSeq.current += 1;
    const mySeq = sessionSeq.current;
    const stored = getToken();
    if (stored === null) {
      setLoading(false);
      return;
    }
    refreshSession(stored)
      .then(({ session, me }) => {
        if (sessionSeq.current !== mySeq) return;
        // Guarda fail-closed: tenant ativo não-nulo nunca comete sem `/me`
        // vinculado (revisão + permissões). O `refreshSession` já lança nesse
        // caso; esta guarda defensiva roteia qualquer `me:null` inesperado
        // para o fail-closed do catch (limpa só o token capturado ainda
        // corrente, nunca um substituto não-nulo).
        if (session.activeTenantId !== null && me === null) {
          throw new ApiError(503, "SESSION_UNAVAILABLE", messageFor503());
        }
        // Resposta de sucesso tardia do token antigo (A) não pode cometer
        // depois que B foi gravado, mesmo antes do storage event processar.
        // Token capturado removido sem substituto: garante anônimo, sem
        // reter identidade antiga; substituto não-nulo é dono do estado.
        const now = getToken();
        if (now !== stored) {
          if (now !== null) return;
          setTokenState(null);
          setUser(null);
          setActiveTenantId(null);
          setTenants([]);
          setPermissions([]);
          commitRevision(null);
          clearApiCache();
          return;
        }
        setTokenState(stored);
        setUser(session.user);
        setActiveTenantId(session.activeTenantId);
        setTenants(session.memberships);
        setPermissions(me?.permissions ?? []);
        commitRevision(session.tenantContextRevision ?? null);
      })
      .catch(() => {
        if (sessionSeq.current !== mySeq) return;
        const now = getToken();
        if (now !== stored) {
          // Token capturado substituído por outro não-nulo (B): não limpa
          // nem reseta o substituto — o evento/transição dele é dono do
          // estado. Token removido/nulo (401 corrente já limpou): reseta
          // anônimo de imediato sem reter identidade antiga.
          if (now !== null) return;
          setTokenState(null);
          setUser(null);
          setActiveTenantId(null);
          setTenants([]);
          setPermissions([]);
          commitRevision(null);
          clearApiCache();
          return;
        }
        // Guarda anti-race (token ainda presente): falha não-401 da
        // restauração com o mesmo token — sessão inválida, limpa e avança.
        clearToken();
        commitRevision(null);
        setTokenState(null);
        setUser(null);
        setActiveTenantId(null);
        setTenants([]);
        setPermissions([]);
        // Sessão restaurada inválida: limpa e avança o escopo (leituras
        // pré-restauração não podem vazar para o próximo login).
        clearApiCache();
        advanceApiGeneration();
        broadcastSessionSignal();
      })
      .finally(() => {
        if (sessionSeq.current !== mySeq) return;
        // Substituto pendente é dono do `loading`: não expõe identidade
        // antiga com `loading=false` antes da transição dele processar.
        // Token removido sem substituto: garante anônimo antes de liberar.
        const now = getToken();
        if (now !== stored && now !== null) return;
        if (stored !== null && now === null) {
          setTokenState(null);
          setUser(null);
          setActiveTenantId(null);
          setTenants([]);
          setPermissions([]);
          commitRevision(null);
          clearApiCache();
        }
        setLoading(false);
      });
  }, []);

  // Sinal cross-tab: outra aba trocou login/logout/token ou o tenant ativo
  // com o mesmo token compartilhado. O `storage` event só dispara nas abas
  // que NÃO escreveram — sem ping-pong. O payload do marcador nunca é
  // confiável como tenant ativo; a sessão do servidor é autoritativa.
  useEffect(() => {
    function resetToAnonymous(): void {
      commitRevision(null);
      setTokenState(null);
      setUser(null);
      setActiveTenantId(null);
      setTenants([]);
      setPermissions([]);
    }
    function onStorage(e: StorageEvent): void {
      if (e.key !== TOKEN_KEY && e.key !== SESSION_SIGNAL_KEY) return;
      // Hold síncrono cross-tab: esconde o conteúdo antigo de imediato e
      // impede qualquer `useApi` protegido de partir com a revisão vencida.
      // O `apiScope` vira `switching:<gen>` no mesmo tick (o `useApi` limpa
      // o dado síncrono no próximo render e não busca/lê cache/expõe dado).
      // Invalida também a revisão antiga do módulo antes do refresh para que
      // nenhuma chamada nova carregue o precondicionante vencido. Limpa o
      // namespace transitório de troca local (o dono agora é este evento) e
      // assume o dedupe síncrono para que o handler de 409 não inicie um
      // segundo refresh concorrente.
      clearApiCache();
      commitRevision(null);
      advanceApiGeneration();
      sessionSeq.current += 1;
      const mySeq = sessionSeq.current;
      setTenantSwitching(true);
      setContextReconciling(true);
      reconcilingRef.current = true;
      switchingRef.current = true;
      setLoading(true);
      const current = getToken();
      function exitStorageHold(): void {
        setTenantSwitching(false);
        setContextReconciling(false);
        reconcilingRef.current = false;
        switchingRef.current = false;
      }
      if (current === null) {
        resetToAnonymous();
        clearApiCache();
        exitStorageHold();
        setLoading(false);
        return;
      }
      refreshSession(current)
        .then(({ session, me }) => {
          if (sessionSeq.current !== mySeq) return;
          // Sucesso tardio do token antigo (A) não comete depois que B foi
          // gravado, mesmo antes do evento da transição de B processar.
          // Token removido sem substituto: garante anônimo; substituto
          // não-nulo é dono do estado e do `loading`.
          const now = getToken();
          if (now !== current) {
            if (now !== null) return;
            resetToAnonymous();
            clearApiCache();
            exitStorageHold();
            return;
          }
          // `/me` ausente só é coerente sem tenant ativo (`activeTenantId`
          // `null`: usuário sem membership, sem escopo `/me` legítimo —
          // permanece autenticado para listar/escolher memberships, com
          // permissões vazias). Com tenant ativo não-nulo, sem permissões
          // confiáveis não há snapshot coerente — fail closed em vez de
          // cometer sessão parcial ou liberar o hold com a identidade
          // antiga. Limpa só o token capturado ainda corrente (nunca um
          // substituto não-nulo); sem broadcast (o sinal que originou este
          // refresh já sincroniza as abas — evita ping-pong).
          if (me === null && session.activeTenantId !== null) {
            if (getToken() === current) clearToken();
            commitRevision(null);
            clearApiCache();
            advanceApiGeneration();
            resetToAnonymous();
            exitStorageHold();
            return;
          }
          // Sessão coerente sem tenant: sem escopo `/me`, permissões vazias —
          // permanece autenticada para listar/escolher memberships.
          if (me === null) {
            setTokenState(current);
            setUser(session.user);
            setActiveTenantId(session.activeTenantId);
            setTenants(session.memberships);
            setPermissions([]);
            commitRevision(session.tenantContextRevision ?? null);
            exitStorageHold();
            return;
          }
          setTokenState(current);
          setUser(session.user);
          setActiveTenantId(session.activeTenantId);
          setTenants(session.memberships);
          setPermissions(me.permissions);
          commitRevision(session.tenantContextRevision ?? null);
          exitStorageHold();
        })
        .catch((err: unknown) => {
          // 401 autoritativo com `sessionSeq` stale (corrida A/B cross-tab):
          // o `/me` de A invalidou o token ainda corrente e o `apiFetch` já
          // limpou storage/cache/geração/broadcast. Mesmo com a seq avançada
          // por B, o contexto antigo não pode ser retido: reseta anônimo de
          // imediato sem tocar em substituto não-nulo. Sem `advance` aqui
          // (o fetch já avançou); `clearApiCache` é idempotente.
          if (isUnauthorized(err) && current !== null && getToken() === null) {
            resetToAnonymous();
            clearApiCache();
            exitStorageHold();
            setLoading(false);
            return;
          }
          if (sessionSeq.current !== mySeq) return;
          const now = getToken();
          if (now !== current) {
            // O token capturado foi removido/invalidado durante o refresh
            // (o `apiFetch` do 401 já limpou e invalidou a geração). Sem
            // substituto, o contexto anterior não pode ser retido: reseta
            // anônimo e mantém cache/geração invalidados. Com substituto
            // não-nulo, não limpa nem reseta — o evento/sessão dele é dono
            // e o `loading` permanece até a transição dele processar.
            // 401 autoritativo do token corrente cai aqui com now===null
            // (limpo pelo `apiFetch`): reseta toda a identidade.
            if (now !== null) return;
            resetToAnonymous();
            clearApiCache();
            exitStorageHold();
            return;
          }
          // 401 autoritativo com o token ainda presente não deveria ocorrer
          // (o `apiFetch` corrente limpa antes de lançar); trata como
          // sessão inválida sem reter identidade antiga.
          if (isUnauthorized(err)) {
            clearToken();
            resetToAnonymous();
            clearApiCache();
            advanceApiGeneration();
            exitStorageHold();
            return;
          }
          // Token inválido na outra aba: reseta sem rebroadcast (evita
          // ping-pong entre abas que descobriram a mesma expiração).
          clearToken();
          resetToAnonymous();
          clearApiCache();
          advanceApiGeneration();
          exitStorageHold();
        })
        .finally(() => {
          if (sessionSeq.current !== mySeq) return;
          // Substituto não-nulo pendente é dono do `loading` e do hold:
          // permanece em hold até o evento/transição dele processar, sem
          // expor dado antigo nem liberar fetch com revisão vencida. Token
          // removido sem substituto: garante anônimo antes de liberar.
          const now = getToken();
          if (now !== current && now !== null) return;
          if (current !== null && now === null) {
            resetToAnonymous();
            clearApiCache();
          }
          exitStorageHold();
          setLoading(false);
        });
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /**
   * Reconciliação autoritativa após 409 `TENANT_CONTEXT_CONFLICT` de chamada
   * protegida não-switch com o token ainda corrente (dono: notificação
   * global do `apiFetch`). Esconde a visão protegida de imediato (hold
   * transitório + `loading`), revalida sessão+me com a revisão do snapshot
   * e comita o vencedor corrente sem logout — o token segue válido e nunca
   * é limpo por causa do conflito original. Sem snapshot coerente
   * autorizado: fail closed. Dedupe síncrono: troca ou reconciliação em voo
   * é dona da revalidação (sem duplicata concorrente).
   */
  const reconcileTenantContext = useCallback(() => {
    const current = getToken();
    if (current === null) return;
    if (reconcilingRef.current || switchingRef.current) return;
    reconcilingRef.current = true;
    sessionSeq.current += 1;
    const mySeq = sessionSeq.current;
    const captured = getToken();
    if (captured === null) {
      reconcilingRef.current = false;
      return;
    }
    setContextReconciling(true);
    setLoading(true);
    function resetAnonymous(): void {
      commitRevision(null);
      setTokenState(null);
      setUser(null);
      setActiveTenantId(null);
      setTenants([]);
      setPermissions([]);
    }
    function failClosed(): void {
      if (getToken() === captured) clearToken();
      commitRevision(null);
      clearApiCache();
      advanceApiGeneration();
      broadcastSessionSignal();
      resetAnonymous();
      setContextReconciling(false);
      setLoading(false);
    }
    refreshSession(captured)
      .then(({ session, me }) => {
        if (sessionSeq.current !== mySeq) return;
        const now = getToken();
        if (now !== captured) {
          if (now !== null) return;
          resetAnonymous();
          clearApiCache();
          setContextReconciling(false);
          setLoading(false);
          return;
        }
        // `/me` ausente só é coerente sem tenant ativo (`activeTenantId`
        // `null`: sem escopo `/me` legítimo — comita sem tenant/permissões
        // vazias para listar/escolher memberships). Com tenant ativo
        // não-nulo, sem permissões confiáveis não há snapshot coerente —
        // fail closed em vez de expor dado vencido. A troca para destino
        // não-nulo segue exigindo confirmação `/me` (fail-closed acima).
        if (me === null && session.activeTenantId !== null) {
          failClosed();
          return;
        }
        if (me === null) {
          commitRevision(session.tenantContextRevision ?? null);
          clearApiCache();
          advanceApiGeneration();
          broadcastSessionSignal();
          setTenantSwitching(false);
          setTokenState(captured);
          setUser(session.user);
          setActiveTenantId(session.activeTenantId);
          setTenants(session.memberships);
          setPermissions([]);
          setContextReconciling(false);
          setLoading(false);
          return;
        }
        commitRevision(session.tenantContextRevision ?? null);
        clearApiCache();
        advanceApiGeneration();
        broadcastSessionSignal();
        setTenantSwitching(false);
        setTokenState(captured);
        setUser(session.user);
        setActiveTenantId(session.activeTenantId);
        setTenants(session.memberships);
        setPermissions(me.permissions);
        setContextReconciling(false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // 401 autoritativo com `sessionSeq` stale: o `/me` invalidou o token
        // ainda corrente e o `apiFetch` já limpou storage/revisão/cache/
        // geração. Garante anônimo sem reter contexto antigo.
        if (isUnauthorized(err) && getToken() === null) {
          clearApiCache();
          resetAnonymous();
          setContextReconciling(false);
          setLoading(false);
          return;
        }
        if (sessionSeq.current !== mySeq) return;
        const now = getToken();
        if (now !== captured) {
          if (now !== null) return;
          clearApiCache();
          resetAnonymous();
          setContextReconciling(false);
          setLoading(false);
          return;
        }
        // 401 autoritativo com o token ainda presente não deveria ocorrer
        // (o `apiFetch` corrente limpa antes de lançar); trata como sessão
        // inválida sem reter identidade antiga.
        if (isUnauthorized(err)) {
          if (getToken() === captured) {
            clearToken();
            commitRevision(null);
            clearApiCache();
            advanceApiGeneration();
          } else {
            clearApiCache();
          }
          resetAnonymous();
          setContextReconciling(false);
          setLoading(false);
          return;
        }
        failClosed();
      })
      .finally(() => {
        reconcilingRef.current = false;
        if (sessionSeq.current !== mySeq) return;
        const now = getToken();
        if (now !== captured && now !== null) return;
        if (captured !== null && now === null) {
          resetAnonymous();
          clearApiCache();
        }
        setContextReconciling(false);
        setLoading(false);
      });
  }, [commitRevision]);

  useEffect(() => {
    setTenantContextConflictHandler(() => {
      reconcileTenantContext();
    });
    return () => setTenantContextConflictHandler(null);
  }, [reconcileTenantContext]);

  const login = useCallback(async (email: string, password: string) => {
    // Invalida restaurações/refreshes antigos no início da transição: uma
    // conclusão tardia de outra geração nunca sobrescreve a nova identidade.
    sessionSeq.current += 1;
    const mySeq = sessionSeq.current;
    setContextReconciling(false);
    reconcilingRef.current = false;
    const preToken = getToken();
    const res = await api.post<LoginResponse>("/v1/auth/login", { email, password });
    // Guarda anti-race: conclusão tardia do login não pode reautorizar
    // nem sobrescrever uma transição posterior (logout/troca), nem cometer
    // depois que outro token (B) foi gravado antes do evento processar.
    if (sessionSeq.current !== mySeq) return;
    if (getToken() !== preToken) return;
    const { session, me } = await refreshSession(res.token);
    if (sessionSeq.current !== mySeq) return;
    if (getToken() !== preToken) return;
    // Fail-closed no login: tenant ativo não-nulo nunca comete sem `/me`
    // vinculado. O `refreshSession` já lança nesse caso; esta guarda impede
    // persistir o token da resposta ou cometer contexto parcial em qualquer
    // retorno inesperado — o erro é propagado sem tocar em substituto
    // não-nulo gravado durante o refresh.
    if (session.activeTenantId !== null && me === null) {
      throw new ApiError(503, "SESSION_UNAVAILABLE", messageFor503());
    }
    setToken(res.token);
    // Avança o escopo junto com a troca de identidade (mesmo tick):
    // o próximo render já enxerga o novo scope, sem exibir o anterior.
    // Garante saída do namespace transitório de troca stale.
    clearApiCache();
    advanceApiGeneration();
    broadcastSessionSignal();
    setTenantSwitching(false);
    setTokenState(res.token);
    setUser(session.user);
    setActiveTenantId(session.activeTenantId);
    setTenants(session.memberships);
    setPermissions(me?.permissions ?? []);
    commitRevision(session.tenantContextRevision ?? null);
  }, [commitRevision]);

  const logout = useCallback(async () => {
    // Local-first: limpa o estado síncrono antes de qualquer rede para que
    // o dado protegido suma de imediato mesmo com o POST pendurado. O
    // resultado remoto nunca restaura a sessão (best-effort com o token
    // antigo capturado). O contrato Promise é preservado (async fn).
    sessionSeq.current += 1;
    const oldToken = getToken();
    clearToken();
    commitRevision(null);
    clearApiCache();
    advanceApiGeneration();
    broadcastSessionSignal();
    setTenantSwitching(false);
    setContextReconciling(false);
    reconcilingRef.current = false;
    setTokenState(null);
    setUser(null);
    setActiveTenantId(null);
    setTenants([]);
    setPermissions([]);
    setLoading(false);
    try {
      await api.post("/v1/auth/logout", {}, oldToken ? { token: oldToken } : {});
    } catch {
      // logout best-effort: a sessão local já foi limpa acima
    }
  }, [commitRevision]);

  const switchTenant = useCallback(async (tenantId: string) => {
    // Invalida refreshes antigos no início da transição para que uma
    // conclusão tardia não vença a identidade nova. Esconde a UI protegida
    // de imediato (`loading=true` faz o `Shell` exibir placeholder; o
    // namespace transitório `switching:<gen>` esconde leituras do `useApi`
    // mesmo sem `Shell`). Sem avanço de geração aqui: o 401 já avança uma
    // vez no `apiFetch`.
    sessionSeq.current += 1;
    const mySeq = sessionSeq.current;
    const captured = getToken();
    setTenantSwitching(true);
    setContextReconciling(false);
    reconcilingRef.current = false;
    setLoading(true);
    function resetAnonymous(): void {
      commitRevision(null);
      setTokenState(null);
      setUser(null);
      setActiveTenantId(null);
      setTenants([]);
      setPermissions([]);
    }
    let postSucceeded = false;
    let postError: unknown = null;
    try {
      // O header `x-tenant-context-revision` com a revisão corrente é
      // anexado automaticamente na invocação; a resposta nunca é comitada
      // direto (outra aba pode ter trocado a sessão entre o POST e a
      // leitura) — só o refresh autoritativo abaixo comita.
      await api.post<SwitchTenantResponse>(`/v1/tenants/${tenantId}/switch`, {});
      postSucceeded = true;
    } catch (err) {
      // 401 autoritativo do token corrente com `sessionSeq` stale (corrida
      // A/B): o POST A invalidou o token ainda corrente e o `apiFetch` já
      // limpou storage/cache/geração/broadcast. Mesmo com a seq avançada por
      // B, o contexto antigo não pode ser retido: reseta anônimo de imediato
      // sem tocar em substituto não-nulo e propaga o 401. Sem `advance` aqui
      // (o fetch já avançou); `clearApiCache` é idempotente.
      if (isUnauthorized(err) && captured !== null && getToken() === null) {
        clearApiCache();
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
        throw err;
      }
      if (sessionSeq.current !== mySeq) return;
      const now = getToken();
      // Substituto não-nulo (B) gravado durante o POST pendente: a resposta
      // tardia (401 ou não) pertence ao token antigo — não limpa nem reseta
      // a identidade nova, e `loading`/`switching` seguem donos de B.
      if (now !== captured && now !== null) return;
      if (isUnauthorized(err)) {
        // 401 anônimo (sem token capturado): nada a resetar, só propaga.
        if (captured === null) {
          setTenantSwitching(false);
          setLoading(false);
          throw err;
        }
        // 401 corrente: o `apiFetch` já removeu o token capturado, limpou o
        // cache, avançou a geração e emitiu o sinal/broadcast. Reseta toda a
        // identidade de imediato sem recriar auth; `clearApiCache` aqui é
        // idempotente (o fetch já invalidou). Guarda defensiva: se o token
        // ainda estiver presente (não deveria), limpa e avança o escopo.
        if (getToken() === captured) {
          clearToken();
          clearApiCache();
          advanceApiGeneration();
        } else {
          clearApiCache();
        }
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
        throw err;
      }
      // Falha não-401: efeito no servidor desconhecido — revalidar abaixo
      // antes de restaurar a UI protegida.
      postError = err;
    }
    if (!postSucceeded) {
      // POST não-401 com seq/token correntes (stale/substituto já retornaram
      // acima). Sem token capturado: nada a reconciliar.
      if (captured === null) {
        if (sessionSeq.current !== mySeq) return;
        setTenantSwitching(false);
        setLoading(false);
        throw postError;
      }
      if (sessionSeq.current !== mySeq) return;
      if (getToken() !== captured) return;
      let revalidated: { session: SessionResponse; me: MeResponse | null };
      try {
        revalidated = await refreshSession(captured);
      } catch (revalErr) {
        if (sessionSeq.current !== mySeq) return;
        // 401 autoritativo da revalidação com token limpo pelo `apiFetch`:
        // já avançou/broadcast uma vez — só reseta, sem duplo avanço.
        if (isUnauthorized(revalErr) && getToken() === null) {
          const now = getToken();
          if (now !== null) return;
          clearApiCache();
          resetAnonymous();
          setTenantSwitching(false);
          setLoading(false);
          throw revalErr;
        }
        if (getToken() !== captured) {
          if (getToken() !== null) return;
          clearApiCache();
          resetAnonymous();
          setTenantSwitching(false);
          setLoading(false);
          throw revalErr;
        }
        // Estado não confirmável após falha de rede/5xx: fail closed — nunca
        // exibir dado antigo sob tenant incerto no servidor.
        if (getToken() === captured) clearToken();
        clearApiCache();
        advanceApiGeneration();
        broadcastSessionSignal();
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
        throw revalErr;
      }
      if (sessionSeq.current !== mySeq) return;
      if (getToken() !== captured) return;
      // `/me` indisponível após POST com falha: sem permissões confiáveis o
      // estado não pode ser confirmado — fail closed, com UMA exceção
      // coerente: sessão autoritativa sem tenant ativo (`activeTenantId`
      // `null` + `me:null` = sem escopo `/me` legítimo) combinada com
      // rejeição definitiva sem efeito (400/403/404, ou 409 com
      // `TENANT_SWITCH_CONFLICT`/`TENANT_CONTEXT_CONFLICT`). Nesse caso a
      // sessão sem tenant é preservada (token capturado, revisão/memberships
      // autoritativos, permissões vazias), o hold sai e o erro é propagado.
      // Falha ambígua (rede/5xx/outro 409) mesmo sem tenant segue fail-closed:
      // o POST pode concluir no servidor depois do refresh.
      if (revalidated.me === null) {
        if (revalidated.session.activeTenantId === null && isDefiniteSwitchNoEffect(postError)) {
          const isNoTenantContextConflict =
            postError instanceof ApiError &&
            (postError.code === "TENANT_SWITCH_CONFLICT" || postError.code === "TENANT_CONTEXT_CONFLICT");
          if (isNoTenantContextConflict) {
            // O tenant autoritativo (vencedor) difere do anterior: invalida
            // o cache do escopo antigo e avança/broadcast como em troca
            // confirmada — sem tocar no token (sem logout/fail-closed).
            clearApiCache();
            advanceApiGeneration();
            broadcastSessionSignal();
          }
          commitRevision(revalidated.session.tenantContextRevision ?? null);
          setTokenState(captured);
          setUser(revalidated.session.user);
          setActiveTenantId(revalidated.session.activeTenantId);
          setTenants(revalidated.session.memberships);
          setPermissions([]);
          setTenantSwitching(false);
          setLoading(false);
          if (isNoTenantContextConflict) throw tenantSwitchConflict();
          throw postError;
        }
        clearToken();
        clearApiCache();
        advanceApiGeneration();
        broadcastSessionSignal();
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
        throw postError;
      }
      // POST com falha definitiva sem mutação (400/403/404 rejeitados antes
      // de `setActiveTenant`, 409 `TENANT_SWITCH_CONFLICT` do compare-and-set
      // rejeitado antes de qualquer mutação, ou 409 `TENANT_CONTEXT_CONFLICT`
      // do guard de precondição rejeitado antes do controller): preserva o
      // auth corrente, comita o tenant autoritativo reconciliado e SEMPRE
      // propaga o erro — mesmo quando o refresh mostra o tenant pedido (outra
      // aba venceu para o mesmo destino). Nos conflitos o servidor nunca
      // aplicou a troca pedida — o vencedor permanece ativo — então o erro
      // sintetizado carrega a mensagem específica que o `Shell` já exibe, em
      // vez da genérica de `messageForStatus(409)`. Este cheque vem ANTES do
      // atalho "POST falhou mas o alvo está ativo" abaixo: erro definitivo
      // nunca é engolido como sucesso eventual.
      if (isDefiniteSwitchNoEffect(postError)) {
        const isContextConflict =
          postError instanceof ApiError &&
          (postError.code === "TENANT_SWITCH_CONFLICT" || postError.code === "TENANT_CONTEXT_CONFLICT");
        if (isContextConflict) {
          // O tenant autoritativo (vencedor) difere do anterior: invalida o
          // cache do escopo antigo e avança/broadcast como em troca
          // confirmada — sem tocar no token (sem logout/fail-closed).
          clearApiCache();
          advanceApiGeneration();
          broadcastSessionSignal();
        }
        commitRevision(revalidated.session.tenantContextRevision ?? null);
        setTokenState(captured);
        setUser(revalidated.session.user);
        setActiveTenantId(revalidated.session.activeTenantId);
        setTenants(revalidated.session.memberships);
        setPermissions(revalidated.me.permissions);
        setTenantSwitching(false);
        setLoading(false);
        if (isContextConflict) throw tenantSwitchConflict();
        throw postError;
      }
      // POST ambíguo (rede/5xx/outro 409) mas o servidor mostra o tenant
      // pedido (resposta perdida): a troca na verdade ocorreu — comita o
      // autoritativo sem rethrow. Só vale para erro ambíguo: erro definitivo
      // já retornou acima com propagação obrigatória.
      if (revalidated.session.activeTenantId === tenantId) {
        commitRevision(revalidated.session.tenantContextRevision ?? null);
        clearApiCache();
        advanceApiGeneration();
        broadcastSessionSignal();
        setTokenState(captured);
        setUser(revalidated.session.user);
        setActiveTenantId(revalidated.session.activeTenantId);
        setTenants(revalidated.session.memberships);
        setPermissions(revalidated.me.permissions);
        setTenantSwitching(false);
        setLoading(false);
        return;
      }
      // Falha ambígua (rede/5xx/outro status não-definitivo): um único refresh
      // imediato dizendo "ainda no tenant antigo" NÃO prova ausência de
      // efeito — o POST pode concluir no servidor depois. Fail closed: nunca
      // reexpor a UI protegida antiga sob tenant incerto; invalida
      // token/cache/contexto e exige restauração de sessão/login.
      clearToken();
      clearApiCache();
      advanceApiGeneration();
      broadcastSessionSignal();
      resetAnonymous();
      setTenantSwitching(false);
      setLoading(false);
      throw postError;
    }
    // Guarda anti-race: resposta tardia da troca não pode sobrescrever um
    // contexto mais novo (logout/troca cross-tab) nem aplicar identidade
    // parcial de outro usuário/tenant. Nenhum estado/cache/broadcast antes
    // da sessão autoritativa confirmar. A resposta do POST nunca é
    // comitada diretamente: outra aba pode ter trocado a sessão
    // compartilhada no servidor entre o POST e a leitura.
    if (sessionSeq.current !== mySeq) return;
    if (getToken() !== captured) return;
    if (captured === null) {
      setTenantSwitching(false);
      setLoading(false);
      return;
    }
    let refreshed: { session: SessionResponse; me: MeResponse | null };
    try {
      refreshed = await refreshSession(captured);
    } catch (err) {
      // 401 autoritativo do token corrente com `sessionSeq` stale (corrida
      // A/B no refresh pós-POST): o `/me` de A invalidou o token ainda
      // corrente e o `apiFetch` já limpou storage/cache/geração/broadcast.
      // Mesmo com a seq avançada por B, o contexto antigo não pode ser
      // retido: reseta anônimo de imediato sem tocar em substituto não-nulo
      // e propaga o 401. Sem `advance` aqui (o fetch já avançou);
      // `clearApiCache` é idempotente.
      if (isUnauthorized(err) && captured !== null && getToken() === null) {
        clearApiCache();
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
        throw err;
      }
      if (sessionSeq.current !== mySeq) return;
      const now = getToken();
      if (now !== captured) {
        // Token substituído por outro não-nulo durante o refresh: não
        // limpa nem reseta o substituto. Token removido/nulo (401 corrente
        // do `/me` limpou via `apiFetch`): reseta toda a identidade sem
        // reter tenant/usuário antigos, e propaga o 401 autoritativo.
        if (now !== null) return;
        clearApiCache();
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
      } else {
        // Snapshot inconsistente/indisponível após POST bem-sucedido:
        // fail closed — limpa token/cache/contexto, anônimo com
        // `loading=false`, sem reter dado antigo. 401 corrente já avançou
        // no `apiFetch` (sem duplo avanço); demais casos avançam uma vez.
        if (isUnauthorized(err)) {
          if (getToken() === captured) {
            clearToken();
            clearApiCache();
            advanceApiGeneration();
          } else {
            clearApiCache();
          }
        } else {
          if (getToken() === captured) clearToken();
          clearApiCache();
          advanceApiGeneration();
          broadcastSessionSignal();
        }
        resetAnonymous();
        setTenantSwitching(false);
        setLoading(false);
      }
      throw err;
    }
    if (sessionSeq.current !== mySeq) return;
    if (getToken() !== captured) return;
    // `/me` indisponível após switch com POST ok: fail closed, nunca cometer
    // sessão sem permissões confiáveis nem exibir dado antigo incerto.
    if (refreshed.me === null) {
      clearToken();
      clearApiCache();
      advanceApiGeneration();
      broadcastSessionSignal();
      resetAnonymous();
      setTenantSwitching(false);
      setLoading(false);
      throw new ApiError(503, "SESSION_UNAVAILABLE", messageFor503());
    }
    // Transição confirmada pelo servidor: limpa, avança o escopo e
    // comita somente o tenant/identidade autoritativos da sessão.
    // Broadcast somente após o servidor confirmar a troca.
    commitRevision(refreshed.session.tenantContextRevision ?? null);
    clearApiCache();
    advanceApiGeneration();
    broadcastSessionSignal();
    setTokenState(captured);
    setUser(refreshed.session.user);
    setActiveTenantId(refreshed.session.activeTenantId);
    setTenants(refreshed.session.memberships);
    setPermissions(refreshed.me.permissions);
    setTenantSwitching(false);
    setLoading(false);
    // POST ok mas a sessão autoritativa indica outro tenant que não o pedido
    // (troca concorrente em outra aba/sessão venceu entre o POST e a
    // leitura): o estado cometido é o autoritativo, mas o operador precisa
    // saber que não está no destino pedido — propaga conflito específico em
    // vez de apresentar o outro tenant em silêncio como se fosse o escolhido.
    if (refreshed.session.activeTenantId !== tenantId) {
      throw tenantSwitchConflict();
    }
  }, [commitRevision]);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      activeTenantId,
      tenants,
      permissions,
      loading,
      tenantContextRevision,
      apiScope,
      login,
      logout,
      switchTenant,
      hasPermission: (p: string) => permissions.includes(p),
    }),
    [token, user, activeTenantId, tenants, permissions, loading, tenantContextRevision, apiScope, login, logout, switchTenant],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth deve ser usado dentro de <AuthProvider>");
  return ctx;
}

/**
 * Escopo do `useApi` sem exigir provider: retorna `null` fora do
 * `AuthProvider` para que o hook use o namespace anônimo/público
 * isolado em vez de lançar.
 */
export function useOptionalApiScope(): string | null {
  const ctx = useContext(AuthContext);
  return ctx?.apiScope ?? null;
}

/**
 * `hasPermission` sem exigir provider, para componentes que também são
 * renderizados fora do `AuthProvider` (testes/préviews). Fail-closed: fora
 * do provider nenhuma permissão é concedida.
 */
export function useOptionalHasPermission(): (permission: string) => boolean {
  const ctx = useContext(AuthContext);
  const permissions = ctx?.permissions;
  return (permission: string) => (permissions ?? []).includes(permission);
}
