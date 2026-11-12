"use client";

import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input, Select, Textarea } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { useOptionalHasPermission } from "../../lib/auth";
import { formatDateTime } from "../../lib/money";
import { api, userMessage } from "../../lib/api";
import { useToast } from "../../components/ui/Toast";
import type { TicketDetail, TicketRow } from "../../lib/api";

export default function SupportPage(): React.JSX.Element {
  const [tab, setTab] = useState<"all" | "mine">("all");
  const path = tab === "all" ? "/v1/tickets" : "/v1/tickets/my-work";
  const { data, error, loading, reload } = useApi<{ tickets: TicketRow[] }>(path);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  return (
    <Shell>
      <h1>Suporte</h1>
      {canWrite ? <NewTicketForm onDone={reload} /> : null}
      <div className="cc-row">
        <Button variant={tab === "all" ? "primary" : "secondary"} onClick={() => { setTab("all"); setSelectedId(null); }}>
          Todos
        </Button>
        <Button variant={tab === "mine" ? "primary" : "secondary"} onClick={() => { setTab("mine"); setSelectedId(null); }}>
          Meu trabalho
        </Button>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.tickets.length === 0 ? (
        <EmptyState title="Nenhum ticket" hint="Tickets abertos pelo time ou pelo agente aparecem aqui." />
      ) : null}
      {data && data.tickets.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Resumo", render: (t) => t.summary.slice(0, 60) },
              { header: "Status", render: (t) => <StatusPill status={t.status} /> },
              { header: "Prioridade", render: (t) => t.priority },
              {
                header: "Ações",
                render: (t) => (
                  <Button variant="secondary" onClick={() => setSelectedId(t.id)}>
                    Abrir
                  </Button>
                ),
              },
            ]}
            rows={data.tickets}
          />
          {selectedId ? <TicketDetailPanel key={selectedId} id={selectedId} /> : <EmptyState title="Selecione um ticket" />}
        </div>
      ) : null}
    </Shell>
  );
}

const WRITE_PERMISSION = "support.ticket.write";
const CRM_PERSON_READ_PERMISSION = "crm.person.read";

/**
 * Espelho do mapa de transições de `apps/api/src/support/support-policy.ts`.
 * O web é hard-boundary (nunca importa código de servidor), então a UI
 * replica a política apenas para habilitar/desabilitar controles — a API
 * continua sendo a autoridade que valida e aplica a transição.
 */
const TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  NEW: ["TRIAGING", "CANCELLED"],
  TRIAGING: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "WAITING_INTERNAL", "WAITING_PROVIDER", "RESOLVED", "CANCELLED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  WAITING_INTERNAL: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  WAITING_PROVIDER: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: ["IN_PROGRESS"],
  CANCELLED: [],
};

/** Resultados que liberam a resolução (SPEC 07 §7: solved → RESOLVED). */
const UNLOCKING_ATTEMPT_OUTCOMES = ["SUCCEEDED", "PARTIAL"];
const SOLUTION_ATTEMPT_OUTCOMES = ["SUCCEEDED", "PARTIAL", "FAILED", "INCONCLUSIVE"] as const;

const TICKET_STATUS_LABELS: Record<string, string> = {
  NEW: "Novo",
  TRIAGING: "Triagem",
  IN_PROGRESS: "Em andamento",
  WAITING_CUSTOMER: "Aguardando cliente",
  WAITING_INTERNAL: "Aguardando interno",
  WAITING_PROVIDER: "Aguardando provedor",
  RESOLVED: "Resolvido",
  CLOSED: "Fechado",
  CANCELLED: "Cancelado",
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface PersonOption {
  id: string;
  canonicalName: string | null;
}

function personLabel(p: PersonOption): string {
  return p.canonicalName !== null && p.canonicalName.trim().length > 0 ? p.canonicalName : p.id.slice(0, 8);
}

const TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

function NewTicketForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { push } = useToast();
  const hasPermission = useOptionalHasPermission();
  const canListPersons = hasPermission(CRM_PERSON_READ_PERMISSION);
  const personsQuery = useApi<{ persons: PersonOption[] }>(canListPersons ? "/v1/crm/persons" : null);
  const persons = personsQuery.data?.persons ?? null;
  const personsAvailable = canListPersons && persons !== null && personsQuery.error === null;
  const personList: PersonOption[] | null = personsAvailable ? persons : null;
  const [personId, setPersonId] = useState("");
  const [summary, setSummary] = useState("");
  const [priority, setPriority] = useState<string>("NORMAL");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // Autofill: com 1 pessoa no tenant, resolve sem exibir seleção.
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

  const submit = async (): Promise<void> => {
    const pid = personId.trim();
    const sum = summary.trim();
    const cat = category.trim();
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
    if (sum.length === 0) {
      setFormError("Resumo é obrigatório.");
      return;
    }
    if (sum.length > 2000) {
      setFormError("Resumo deve ter no máximo 2000 caracteres.");
      return;
    }
    if (cat.length > 120) {
      setFormError("Categoria deve ter no máximo 120 caracteres.");
      return;
    }
    setFormError(null);
    setApiError(null);
    setBusy(true);
    try {
      await api.post("/v1/tickets", {
        personId: pid,
        summary: sum,
        priority,
        ...(cat.length > 0 ? { category: cat } : {}),
      });
      setPersonId("");
      setSummary("");
      setPriority("NORMAL");
      setCategory("");
      // Com autofill de pessoa única, restaura a seleção automática.
      if (autoPerson !== null) setPersonId(autoPerson.id);
      push("Ticket aberto.");
      onDone();
    } catch (err) {
      setApiError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Novo ticket">
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
            Ticket para {personLabel(autoPerson)} (seleção automática).
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
            <Input value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={busy} placeholder="00000000-0000-4000-8000-000000000000" />
          </Field>
        ) : null}
        <Field label="Resumo">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} disabled={busy} />
        </Field>
        <Field label="Prioridade">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={busy}>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Categoria (opcional)">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy} />
        </Field>
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? "Abrindo…" : "Abrir ticket"}
        </Button>
        {formError ? <p className="cc-field-error">{formError}</p> : null}
        {apiError ? <p className="cc-muted">{apiError}</p> : null}
      </div>
    </Card>
  );
}

function TicketDetailPanel({ id }: { id: string }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<TicketDetail>(`/v1/tickets/${id}`);
  const { push } = useToast();
  const [outcome, setOutcome] = useState("SUCCEEDED");
  const [procedureKey, setProcedureKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runAction = async (action: () => Promise<unknown>, successMessage: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await action();
      push(successMessage);
      reload();
    } catch (err) {
      setMsg(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Ticket não encontrado" />;
  const t = data.ticket;
  const nextStatuses = TICKET_TRANSITIONS[t.status] ?? [];
  const transitionStatuses = nextStatuses.filter((status) => status !== "RESOLVED");
  const hasUnlockingAttempt = data.attempts.some((a) => UNLOCKING_ATTEMPT_OUTCOMES.includes(a.outcome));
  const canResolve = nextStatuses.includes("RESOLVED") && hasUnlockingAttempt;

  return (
    <Card title="Detalhe do ticket">
      <p>{t.summary}</p>
      <div className="cc-row">
        <StatusPill status={t.status} />
        <span className="cc-muted">{t.priority} · {t.category}</span>
        <span className="cc-muted">Criado em {formatDateTime(t.createdAt)}</span>
      </div>

      <h4>Transições</h4>
      {nextStatuses.length === 0 ? (
        <p className="cc-muted">Status {TICKET_STATUS_LABELS[t.status] ?? t.status} não tem transições disponíveis.</p>
      ) : (
        <div className="cc-row">
          {transitionStatuses.map((to) => (
            <Button
              key={to}
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void runAction(
                  () => api.post(`/v1/tickets/${id}/transition`, { toStatus: to }),
                  `Ticket movido para ${TICKET_STATUS_LABELS[to] ?? to}.`,
                )
              }
            >
              {TICKET_STATUS_LABELS[to] ?? to}
            </Button>
          ))}
        </div>
      )}

      <h4>Tentativas de solução ({data.attempts.length})</h4>
      {data.attempts.length === 0 ? (
        <p className="cc-muted">Nenhuma tentativa registrada. A resolução exige uma tentativa com resultado SUCCEEDED ou PARTIAL.</p>
      ) : (
        <ul>
          {data.attempts.map((a) => (
            <li key={a.id}>
              #{a.attemptNo} <StatusPill status={a.outcome} /> <span className="cc-muted">{a.actorType}</span>
              {a.procedureKey !== null ? <span className="cc-muted"> · {a.procedureKey}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="cc-form cc-u-mt-2">
        <Field label="Procedimento (chave)">
          <Input
            value={procedureKey}
            onChange={(e) => setProcedureKey(e.target.value)}
            disabled={busy}
            placeholder="ex.: restart-app"
          />
        </Field>
        <Field label="Resultado da tentativa">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} disabled={busy}>
            {SOLUTION_ATTEMPT_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="secondary"
          disabled={busy || procedureKey.trim().length === 0}
          onClick={() =>
            void runAction(
              () =>
                api.post(`/v1/tickets/${id}/attempts`, {
                  procedureKey: procedureKey.trim(),
                  outcome,
                }),
              "Tentativa de solução registrada.",
            )
          }
        >
          Registrar tentativa
        </Button>
      </div>

      <h4>Resolver</h4>
      <div className="cc-form">
        <p className="cc-muted">
          {canResolve
            ? "Resolução habilitada: o ticket está em atendimento e há tentativa com SUCCEEDED/PARTIAL."
            : hasUnlockingAttempt
              ? t.status === "TRIAGING"
                ? "Mova o ticket de Triagem para Em andamento para habilitar a resolução."
                : "O ticket precisa estar em atendimento (IN_PROGRESS/WAITING_*) para resolver."
              : "Registre uma tentativa com resultado SUCCEEDED ou PARTIAL para habilitar a resolução."}
        </p>
        <Button
          disabled={busy || !canResolve}
          onClick={() =>
            void runAction(
              () => api.post(`/v1/tickets/${id}/resolve`, { outcome: "SUCCEEDED" }),
              "Ticket resolvido.",
            )
          }
        >
          {busy ? "Resolvendo…" : "Resolver ticket"}
        </Button>
        {msg ? <p className="cc-muted">{msg}</p> : null}
      </div>
    </Card>
  );
}
