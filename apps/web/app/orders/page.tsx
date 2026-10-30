"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Shell } from "../../components/Shell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Toast";
import { useApi } from "../../lib/useApi";
import { useOptionalHasPermission } from "../../lib/auth";
import { formatDateTime, formatMinor } from "../../lib/money";
import { CopySnippet } from "../../components/ui/CopySnippet";
import { api, ApiError, userMessage } from "../../lib/api";
import type { CatalogPlan, OrderDetail, OrderRow } from "../../lib/api";

const WRITE_PERMISSION = "commerce.order.write";
const CHARGE_WRITE_PERMISSION = "billing.charge.write";
const SUBSCRIPTION_WRITE_PERMISSION = "subscription.write";
const CRM_PERSON_READ_PERMISSION = "crm.person.read";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DEFAULT_PILOT_PLAN_ID = "00000000-0000-4000-8000-000000000311";

const SELLABLE_TYPES = [
  { value: "PLAN", label: "Plano (PLAN)" },
  { value: "PRODUCT", label: "Produto (PRODUCT)" },
  { value: "ADDON", label: "Adicional / Conexão (ADDON)" },
] as const;

const ORDER_TYPES = [
  { value: "NEW_SUBSCRIPTION", label: "Nova Assinatura" },
  { value: "RENEWAL", label: "Renovação" },
  { value: "ADDON", label: "Adicional" },
  { value: "APP", label: "App" },
  { value: "MIXED", label: "Misto" },
  { value: "ADJUSTMENT", label: "Ajuste" },
] as const;

interface PersonOption {
  id: string;
  canonicalName: string | null;
}

function personLabel(p: PersonOption): string {
  return p.canonicalName !== null && p.canonicalName.trim().length > 0 ? p.canonicalName : p.id.slice(0, 8);
}

function rowAmount(r: OrderRow): string | number {
  return r.netAmountMinor ?? r.net_amount_minor ?? 0;
}

function rowCreated(r: OrderRow): string | null {
  return r.createdAt ?? r.created_at ?? null;
}

// ---------------------------------------------------------------------------
// Idempotência PIX por pedido (G01B, issue #90 parte 4.2).
// A key é estável por pedido em `localStorage` (`pix-idempotency-key:<orderId>`),
// gerada UMA vez ANTES do primeiro POST e reutilizada em retries, reloads e
// abas simultâneas — o backend (CommandBus claim por tenant+scope+key) faz
// replay da cobrança existente em vez de criar nova no provider.
// ---------------------------------------------------------------------------

const PIX_IDEMPOTENCY_KEY_PREFIX = "pix-idempotency-key:";

function pixStorageKey(orderId: string): string {
  return `${PIX_IDEMPOTENCY_KEY_PREFIX}${orderId}`;
}

function readPixIdempotencyKey(orderId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(pixStorageKey(orderId));
  } catch {
    return null;
  }
}

function writePixIdempotencyKey(orderId: string, key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(pixStorageKey(orderId), key);
  } catch {
    // armazenamento indisponível: a tentativa segue sem persistência
  }
}

function clearPixIdempotencyKey(orderId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(pixStorageKey(orderId));
  } catch {
    // best-effort
  }
}

function newPixIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fallback abaixo
  }
  return `pix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const PIX_TERMINAL_FAILURE = new Set(["EXPIRED", "CANCELLED", "FAILED"]);
const PIX_TERMINAL_SUCCESS = new Set(["PAID", "SETTLED"]);

function pixTerminalOf(status: string | undefined): "failed" | "paid" | null {
  if (!status) return null;
  const s = status.trim().toUpperCase();
  if (PIX_TERMINAL_FAILURE.has(s)) return "failed";
  if (PIX_TERMINAL_SUCCESS.has(s)) return "paid";
  return null;
}

interface PixCharge {
  id: string;
  status: string;
  providerChargeId?: string | null;
  qrCode?: string | null;
  effectUncertain?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function OrdersPage(): React.JSX.Element {
  const { data, error, loading, reload, refresh } = useApi<{ orders: OrderRow[] }>("/v1/orders");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const handleOrderCreated = (newId: string): void => {
    reload();
    setSelectedId(newId);
  };

  return (
    <Shell>
      <div className="cc-row cc-u-mb-4" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1>Pedidos</h1>
        <div className="cc-row">
          <Button variant="secondary" onClick={reload}>
            Recarregar
          </Button>
          {canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              Novo pedido
            </Button>
          ) : null}
        </div>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.orders.length === 0 ? (
        <EmptyState title="Nenhum pedido" hint="Pedidos cotados e submetidos aparecem aqui." />
      ) : null}
      {data && data.orders.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            searchable
            searchPlaceholder="Filtrar pedidos…"
            columns={[
              { header: "Status", render: (o) => <StatusPill status={o.status} /> },
              { header: "Total", render: (o) => formatMinor(rowAmount(o), o.currency) },
              { header: "Criado em", render: (o) => formatDateTime(rowCreated(o)) },
              {
                header: "Ações",
                render: (o) => (
                  <Button variant="secondary" onClick={() => setSelectedId(o.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={data.orders}
          />
          {selectedId ? (
            <OrderDetailPanel
              key={selectedId}
              id={selectedId}
              canWrite={canWrite}
              onOrderMutated={refresh}
            />
          ) : (
            <EmptyState title="Selecione um pedido" />
          )}
        </div>
      ) : null}
      {canWrite ? (
        <CreateOrderDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onDone={handleOrderCreated}
        />
      ) : null}
    </Shell>
  );
}

function OrderDetailPanel({
  id,
  canWrite,
  onOrderMutated,
}: {
  id: string;
  canWrite: boolean;
  onOrderMutated: () => void;
}): React.JSX.Element {
  const { data, error, loading, reload, refresh } = useApi<OrderDetail>(`/v1/orders/${id}`);
  const { push } = useToast();
  const hasPermission = useOptionalHasPermission();
  const canWriteOrder = canWrite || hasPermission(WRITE_PERMISSION);
  const canWriteCharge = hasPermission(CHARGE_WRITE_PERMISSION);
  const canWriteSubscription = hasPermission(SUBSCRIPTION_WRITE_PERMISSION);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pixNotice, setPixNotice] = useState<string | null>(null);
  const [effectUncertain, setEffectUncertain] = useState(false);
  const [pixTerminal, setPixTerminal] = useState<"failed" | "paid" | null>(null);
  const [createdCharge, setCreatedCharge] = useState<{
    id: string;
    status: string;
    providerChargeId?: string | null;
    qrCode?: string | null;
  } | null>(null);
  const [createdSubscription, setCreatedSubscription] = useState<{
    id: string;
    status: string;
    already: boolean;
  } | null>(null);
  const pixRecoveredRef = useRef(false);

  // Recovery no mount: se há key estável armazenada e o pedido segue
  // AWAITING_PAYMENT, re-POST o MESMO body com a MESMA key (o bus faz replay
  // da cobrança existente, sem nova cobrança no provider) e restaura o
  // payload copia-e-cola via GET /v1/charges/:id/pix (usa `payload`, NUNCA
  // `encodedImage`).
  useEffect(() => {
    const order = data?.order;
    if (!order || order.status !== "AWAITING_PAYMENT") return;
    if (pixRecoveredRef.current || createdCharge) return;
    const storedKey = readPixIdempotencyKey(order.id);
    if (!storedKey) return;
    pixRecoveredRef.current = true;
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const replayed = await api.post<PixCharge>(
          "/v1/charges",
          { orderId: order.id, paymentMethod: "PIX", billingType: "PIX" },
          { idempotencyKey: storedKey },
        );
        let withPix = replayed;
        if (!replayed.qrCode && replayed.id) {
          try {
            const pix = await api.get<{
              chargeId: string;
              payload: string | null;
              encodedImage: string | null;
              expirationDate: string | null;
            }>(`/v1/charges/${replayed.id}/pix`);
            if (pix.payload) withPix = { ...replayed, qrCode: pix.payload };
          } catch {
            // Best effort: a cobrança foi recuperada mesmo sem o payload
          }
        }
        if (cancelled) return;
        setCreatedCharge(withPix);
        setPixTerminal(pixTerminalOf(withPix.status));
        if (withPix.effectUncertain) {
          setEffectUncertain(true);
          setPixNotice("Pagamento em processamento — não gere nova cobrança. Use Atualizar para reconciliar.");
        }
      } catch {
        // Best effort: a key segue armazenada; a próxima tentativa manual
        // reutiliza a mesma key (replay seguro, sem nova cobrança).
        pixRecoveredRef.current = false;
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, createdCharge]);

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Pedido não encontrado" />;
  const o = data.order;

  const submitOrder = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/v1/orders/${id}/submit`, {});
      push("Pedido submetido (AWAITING_PAYMENT).");
      refresh();
      onOrderMutated();
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelOrder = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/v1/orders/${id}/cancel`, {});
      push("Pedido cancelado.");
      refresh();
      onOrderMutated();
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const generatePixCharge = async (forceNew = false): Promise<void> => {
    setBusy(true);
    setActionError(null);
    setPixNotice(null);
    try {
      const personId = o.person_id ?? o.personId;
      if (personId) {
        try {
          await api.post("/v1/billing-customers/provision", { personId });
        } catch {
          // Best-effort; charge.create will fail closed if binding missing
        }
      }
      // Key estável por pedido: gerada uma vez ANTES do POST e guardada em
      // localStorage; retries, reloads e abas simultâneas reutilizam a mesma
      // key (o bus serializa: replay / 409 in_progress / conflict).
      // `forceNew` (cobrança anterior em estado final EXPIRED/CANCELLED/FAILED)
      // limpa a key armazenada e cria uma nova — nunca bloqueia cobrança nova
      // legítima. PAID/SETTLED nunca chegam aqui (sem botão de nova).
      if (forceNew) {
        clearPixIdempotencyKey(o.id);
        setCreatedCharge(null);
        setPixTerminal(null);
        setEffectUncertain(false);
      }
      let idempotencyKey = forceNew ? null : readPixIdempotencyKey(o.id);
      if (!idempotencyKey) {
        idempotencyKey = newPixIdempotencyKey();
        writePixIdempotencyKey(o.id, idempotencyKey);
      }
      const chargeBody = { orderId: o.id, paymentMethod: "PIX", billingType: "PIX" };
      const postCharge = (): Promise<PixCharge> =>
        api.post<PixCharge>("/v1/charges", chargeBody, { idempotencyKey: idempotencyKey as string });
      let charge: PixCharge;
      try {
        charge = await postCharge();
      } catch (err) {
        // 409 in_progress: outra tentativa (retry, reload, cross-tab) ainda
        // está em curso no bus. Informa a UI e tenta UM replay após espera
        // curta — sem polling infinito.
        if (err instanceof ApiError && err.status === 409) {
          setPixNotice("Pagamento em processamento — não gere nova cobrança. Tentando recuperar a cobrança existente…");
          await sleep(400);
          try {
            charge = await postCharge();
          } catch (retryErr) {
            if (retryErr instanceof ApiError && retryErr.status === 409) {
              setPixNotice("Pagamento em processamento — não gere nova cobrança. Use Atualizar para reconciliar.");
              return;
            }
            throw retryErr;
          }
        } else {
          throw err;
        }
      }
      let chargeWithPix = charge;
      if (!charge.qrCode && charge.id) {
        try {
          const pix = await api.get<{
            chargeId: string;
            payload: string | null;
            encodedImage: string | null;
            expirationDate: string | null;
          }>(`/v1/charges/${charge.id}/pix`);
          // Restaura o copia-e-cola a partir de `payload` — NUNCA `encodedImage`.
          if (pix.payload) {
            chargeWithPix = { ...charge, qrCode: pix.payload };
          }
        } catch {
          // Best effort - may not be available immediately
        }
      }
      setCreatedCharge(chargeWithPix);
      setPixTerminal(pixTerminalOf(chargeWithPix.status));
      if (chargeWithPix.effectUncertain) {
        setEffectUncertain(true);
        setPixNotice("Pagamento em processamento — não gere nova cobrança. Use Atualizar para reconciliar.");
      } else {
        setEffectUncertain(false);
      }
      push("Cobrança PIX gerada com sucesso!");
      refresh();
      onOrderMutated();
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createSubscription = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const sub = await api.post<{
        id: string;
        status: string;
        already: boolean;
      }>("/v1/subscriptions/from-order", {
        orderId: o.id,
      });
      setCreatedSubscription(sub);
      push(sub.already ? "Assinatura já existia para este pedido." : "Assinatura criada com sucesso!");
      refresh();
      onOrderMutated();
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hasAnyAction =
    (canWriteOrder && (o.status === "DRAFT" || o.status === "AWAITING_PAYMENT")) ||
    (canWriteCharge && o.status === "AWAITING_PAYMENT") ||
    (canWriteSubscription && o.status === "SETTLED");

  return (
    <Card title="Detalhe do pedido">
      <p className="cc-mono">{o.id}</p>
      <div className="cc-row">
        <StatusPill status={o.status} />
        <strong>{formatMinor(o.net_amount_minor, o.currency)}</strong>
      </div>
      <ul>
        <li>Bruto: {formatMinor(o.gross_amount_minor, o.currency)}</li>
        <li>Desconto: {formatMinor(o.discount_amount_minor, o.currency)}</li>
        <li>Recompensa: {formatMinor(o.reward_amount_minor, o.currency)}</li>
        <li>Liquidado: {formatMinor(o.settled_amount_minor, o.currency)}</li>
      </ul>
      <h4>Itens</h4>
      {data.items.length === 0 ? (
        <p className="cc-muted">Sem itens.</p>
      ) : (
        <ul>
          {data.items.map((i) => (
            <li key={i.id}>
              {i.item_type} ({i.sellable_type}) × {i.quantity} — {formatMinor(i.net_minor, o.currency)}
            </li>
          ))}
        </ul>
      )}
      {hasAnyAction || createdCharge || createdSubscription ? (
        <div className="cc-u-mt-4">
          <h4>Ações do pedido</h4>
          <div className="cc-row">
            {canWriteOrder && o.status === "DRAFT" ? (
              <Button disabled={busy} onClick={() => void submitOrder()}>
                {busy ? "Submetendo…" : "Submeter pedido"}
              </Button>
            ) : null}
            {canWriteOrder && (o.status === "DRAFT" || o.status === "AWAITING_PAYMENT") ? (
              <Button variant="secondary" disabled={busy} onClick={() => void cancelOrder()}>
                {busy ? "Cancelando…" : "Cancelar pedido"}
              </Button>
            ) : null}
            {canWriteCharge && o.status === "AWAITING_PAYMENT" && !effectUncertain && !createdCharge ? (
              <Button disabled={busy} onClick={() => void generatePixCharge()}>
                {busy ? "Gerando cobrança…" : "Gerar cobrança PIX"}
              </Button>
            ) : null}
            {canWriteCharge && o.status === "AWAITING_PAYMENT" && pixTerminal === "failed" && !effectUncertain ? (
              <Button disabled={busy} onClick={() => void generatePixCharge(true)}>
                {busy ? "Gerando cobrança…" : "Gerar nova cobrança"}
              </Button>
            ) : null}
            {canWriteSubscription && o.status === "SETTLED" ? (
              <Button disabled={busy} onClick={() => void createSubscription()}>
                {busy ? "Criando assinatura…" : "Criar assinatura"}
              </Button>
            ) : null}
          </div>
          {actionError ? <p className="cc-field-error cc-u-mt-2">{actionError}</p> : null}
          {pixNotice ? <p role="status" className="cc-muted cc-u-mt-2">{pixNotice}</p> : null}
          {createdCharge ? (
            <div className="cc-card cc-u-mt-3" style={{ padding: "0.85rem", background: "var(--cc-bg-surface-elevated, #fbfbfb)" }}>
              <p><strong>Cobrança PIX gerada:</strong></p>
              <p className="cc-mono">ID: {createdCharge.id}</p>
              {createdCharge.providerChargeId ? (
                <p className="cc-mono">Provedor: {createdCharge.providerChargeId}</p>
              ) : null}
              <p>Status: <StatusPill status={createdCharge.status} /></p>
              {createdCharge.qrCode ? (
                <div className="cc-u-mt-3 cc-u-mb-2">
                  <p><strong>Instrução de Pagamento PIX (Copia e Cola):</strong></p>
                  <CopySnippet text={createdCharge.qrCode} label="código PIX Copia e Cola" className="cc-u-mb-2" />
                  <p className="cc-muted" style={{ fontSize: "0.85rem" }}>
                    Instruções: Abra o app bancário do pagador, selecione &quot;Pagar com PIX Copia e Cola&quot; e cole o código acima. A liquidação é confirmada via webhook.
                  </p>
                </div>
              ) : null}
              <div className="cc-row cc-u-mt-2" style={{ alignItems: "center", gap: "0.5rem" }}>
                <Button variant="secondary" onClick={() => { refresh(); onOrderMutated(); }}>
                  Atualizar status do pedido
                </Button>
                <Link href="/billing" className="cc-u-ml-2">Ver cobranças em /billing</Link>
              </div>
            </div>
          ) : null}
          {createdSubscription ? (
            <div className="cc-card cc-u-mt-3" style={{ padding: "0.75rem" }}>
              <p><strong>Assinatura gerada:</strong></p>
              <p className="cc-mono">ID: {createdSubscription.id}</p>
              <p>Status: <StatusPill status={createdSubscription.status} /></p>
              <p>
                <Link href="/subscriptions">Ver assinaturas em /subscriptions</Link> · <Link href="/fulfillment">Ir para /fulfillment</Link>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function CreateOrderDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (orderId: string) => void;
}): React.JSX.Element {
  const { push } = useToast();
  const hasPermission = useOptionalHasPermission();
  const canListPersons = hasPermission(CRM_PERSON_READ_PERMISSION);
  const personsQuery = useApi<{ persons: PersonOption[] }>(canListPersons ? "/v1/crm/persons" : null);
  const persons = personsQuery.data?.persons ?? null;
  const personsAvailable = canListPersons && persons !== null && personsQuery.error === null;
  const personList: PersonOption[] | null = personsAvailable ? persons : null;

  const plansQuery = useApi<{ plans: CatalogPlan[] }>("/v1/catalog/plans");
  const catalogPlans = plansQuery.data?.plans ?? null;
  const plansAvailable = catalogPlans !== null && catalogPlans.length > 0;

  const [personId, setPersonId] = useState("");
  const [sellableType, setSellableType] = useState<"PLAN" | "PRODUCT" | "ADDON">("PLAN");
  const [sellableId, setSellableId] = useState(DEFAULT_PILOT_PLAN_ID);

  useEffect(() => {
    if (plansAvailable && catalogPlans.length > 0) {
      if (!catalogPlans.some((p) => p.id === sellableId)) {
        const first = catalogPlans[0];
        if (first) setSellableId(first.id);
      }
    }
  }, [plansAvailable, catalogPlans, sellableId]);
  const [quantity, setQuantity] = useState("1");
  const [orderType, setOrderType] = useState<string>("NEW_SUBSCRIPTION");
  const [currency, setCurrency] = useState("BRL");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // Autofill: com 1 pessoa no tenant, resolve automaticamente.
  useEffect(() => {
    if (personList !== null && personList.length === 1) {
      const only = personList[0];
      if (only !== undefined && personId === "") setPersonId(only.id);
    }
  }, [personList, personId]);

  const showPersonSelect = personList !== null && personList.length > 1;
  const showAutoPerson = personList !== null && personList.length === 1;
  const showManualPerson = personList === null || personList.length === 0;
  const autoPerson: PersonOption | null = showAutoPerson ? (personList?.[0] ?? null) : null;

  const handleQuoteAndMaybeSubmit = async (autoSubmit: boolean): Promise<void> => {
    const pid = (personId || (autoPerson ? autoPerson.id : "")).trim();
    const sid = sellableId.trim();
    const qty = parseInt(quantity, 10);
    const curr = currency.trim().toUpperCase();

    if (showPersonSelect || showAutoPerson) {
      if (pid.length === 0) {
        setFormError("Selecione uma pessoa.");
        return;
      }
      if (!UUID_RE.test(pid) || personList === null || !personList.some((p) => p.id === pid)) {
        setFormError("Selecione uma pessoa válida.");
        return;
      }
    } else {
      if (!UUID_RE.test(pid)) {
        setFormError("ID da pessoa deve ser um UUID válido.");
        return;
      }
    }

    if (!UUID_RE.test(sid)) {
      setFormError("ID do item vendável deve ser um UUID válido.");
      return;
    }

    if (isNaN(qty) || qty < 1 || qty > 1000) {
      setFormError("Quantidade deve ser um número inteiro entre 1 e 1000.");
      return;
    }

    if (curr.length > 0 && !/^[A-Z]{3}$/.test(curr)) {
      setFormError("Moeda deve ter 3 letras maiúsculas (ex: BRL).");
      return;
    }

    setFormError(null);
    setApiError(null);
    setBusy(true);

    try {
      const quoteBody: Record<string, unknown> = {
        personId: pid,
        items: [{ sellableType, sellableId: sid, quantity: qty }],
        orderType,
        ...(curr.length === 3 ? { currency: curr } : {}),
      };

      const quoteIdempotency = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `quote-${Date.now()}`;
      const quoted = await api.post<{ id: string; status: string }>(
        "/v1/orders/quote",
        quoteBody,
        { idempotencyKey: quoteIdempotency },
      );
      const createdId = quoted.id;

      if (autoSubmit) {
        const submitIdempotency = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `subm-${Date.now()}`;
        await api.post(`/v1/orders/${createdId}/submit`, {}, { idempotencyKey: submitIdempotency });
        push("Pedido cotado e submetido (AWAITING_PAYMENT).");
      } else {
        push("Pedido cotado em rascunho (DRAFT).");
      }

      onClose();
      onDone(createdId);
    } catch (err) {
      setApiError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Novo pedido" open={open} onClose={onClose}>
      <div className="cc-form">
        {canListPersons && personsQuery.loading ? (
          <Field label="Pessoa">
            <Select disabled value="">
              <option value="">Carregando pessoas…</option>
            </Select>
          </Field>
        ) : null}
        {showAutoPerson && autoPerson !== null ? (
          <p className="cc-muted">
            Pedido para {personLabel(autoPerson)} (seleção automática).
          </p>
        ) : null}
        {showPersonSelect ? (
          <Field label="Pessoa">
            <Select value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={busy}>
              <option value="">Selecione…</option>
              {personList?.map((p) => (
                <option key={p.id} value={p.id}>
                  {personLabel(p)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {showManualPerson ? (
          <Field label="ID da pessoa (UUID)">
            <Input
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              disabled={busy}
              placeholder="00000000-0000-4000-8000-000000000000"
            />
          </Field>
        ) : null}

        <Field label="Tipo de item vendável">
          <Select
            value={sellableType}
            onChange={(e) => setSellableType(e.target.value as "PLAN" | "PRODUCT" | "ADDON")}
            disabled={busy}
          >
            {SELLABLE_TYPES.map((st) => (
              <option key={st.value} value={st.value}>
                {st.label}
              </option>
            ))}
          </Select>
        </Field>

        {sellableType === "PLAN" && plansAvailable ? (
          <Field label="Plano do catálogo">
            <Select
              value={sellableId}
              onChange={(e) => setSellableId(e.target.value)}
              disabled={busy}
            >
              {catalogPlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatMinor(p.priceMinor, p.currency)} ({p.billingIntervalCount} {p.billingIntervalUnit})
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="ID do item vendável (UUID)">
            <Input
              value={sellableId}
              onChange={(e) => setSellableId(e.target.value)}
              disabled={busy}
              placeholder="00000000-0000-4000-8000-000000000311"
            />
          </Field>
        )}

        <Field label="Quantidade">
          <Input
            type="number"
            min="1"
            max="1000"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={busy}
          />
        </Field>

        <Field label="Tipo de pedido">
          <Select value={orderType} onChange={(e) => setOrderType(e.target.value)} disabled={busy}>
            {ORDER_TYPES.map((ot) => (
              <option key={ot.value} value={ot.value}>
                {ot.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Moeda (opcional)">
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={busy}
            placeholder="BRL"
          />
        </Field>

        {formError ? <p className="cc-field-error">{formError}</p> : null}
        {apiError ? <p className="cc-field-error">{apiError}</p> : null}

        <div className="cc-row cc-u-mt-4">
          <Button disabled={busy} onClick={() => void handleQuoteAndMaybeSubmit(true)}>
            {busy ? "Processando…" : "Cotar e submeter"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void handleQuoteAndMaybeSubmit(false)}>
            {busy ? "Processando…" : "Cotar rascunho"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
