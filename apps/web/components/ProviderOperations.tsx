"use client";

import { useEffect, useState } from "react";
import {
  api,
  userMessage,
  isSyntheticProviderOperation,
  providerOperationsQuery,
  PROVIDER_OPERATION_READ_PERMISSION,
  PROVIDER_OPERATION_STATUSES,
  PROVIDER_OPERATION_WRITE_PERMISSION,
  type ListProviderOperationsResponse,
  type ProviderOperationDetail,
  type ProviderResolveOutcome,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { formatDateTime } from "../lib/money";
import { StatusPill } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Dialog } from "./ui/Dialog";
import { Field, Select, Textarea } from "./ui/Input";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { Table } from "./ui/Table";
import { useToast } from "./ui/Toast";

/**
 * Fila de operações de provider (GET /v1/provider/operations + detalhe).
 *
 * Superfície SOMENTE LEITURA sobre a projeção sanitizada da API: o payload
 * operacional, o resumo do adaptador, referências de segredo, correlação,
 * evidência e trace refs nunca chegam a este componente — quando existem no
 * banco, a API simplesmente não os projeta.
 *
 * Ações do operador (reconciliação e resolução) ficam atrás de
 * `provider.operation.write`, e a opção SUCCEEDED só aparece para adapters
 * sintéticos (echo/manual): para uma operação com proveniência real
 * (`secret-required-v1`) o servidor recusa SUCCEEDED/FAILED — o efeito só
 * pode ser concluído por readback conclusivo do dispatcher.
 */
export function ProviderOperations(): React.JSX.Element {
  const { hasPermission } = useAuth();
  const canRead = hasPermission(PROVIDER_OPERATION_READ_PERMISSION);
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep link do Centro HITL: /provider-operations?id=<id>. Lido no mount a
  // partir de `window.location.search` (evita `useSearchParams`, que exigiria
  // Suspense boundary no App Router).
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("id");
    if (fromQuery !== null && fromQuery.length > 0) setSelectedId(fromQuery);
  }, []);

  // Sem a permissão de leitura nenhuma requisição é disparada (`null` = hook
  // inerte) e o operador vê o estado negado em vez de uma fila vazia.
  const { data, error, loading, reload } = useApi<ListProviderOperationsResponse>(
    canRead ? providerOperationsQuery({ status }) : null,
  );

  if (!canRead) {
    return (
      <EmptyState
        title="Sem permissão para operações de provider"
        hint="Esta tela exige a permissão provider.operation.read do seu perfil neste tenant."
      />
    );
  }

  const operations = data?.operations ?? [];

  return (
    <div>
      <div className="cc-row" style={{ marginBottom: "1rem" }}>
        <label className="cc-muted" htmlFor="provider-operation-status">
          Status:
        </label>
        <Select
          id="provider-operation-status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ maxWidth: "240px" }}
        >
          <option value="">Todos</option>
          {PROVIDER_OPERATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
      {loading ? <LoadingSkeleton lines={6} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data !== null && operations.length === 0 ? (
        <EmptyState
          title="Nenhuma operação de provider"
          hint="Operações pedidas para o provedor aparecem aqui assim que forem criadas."
        />
      ) : null}
      {operations.length > 0 ? (
        <div className="cc-grid-2">
          <Table
            columns={[
              { header: "Status", render: (op) => <StatusPill status={op.status} /> },
              { header: "Ação", render: (op) => <span className="cc-mono">{op.action}</span> },
              { header: "Certeza do efeito", render: (op) => <span className="cc-mono">{op.effectCertainty}</span> },
              { header: "Solicitada em", render: (op) => formatDateTime(op.requestedAt) },
              { header: "Tentativas", render: (op) => String(op.attempts) },
              {
                header: "Ações",
                render: (op) => (
                  <Button variant="secondary" onClick={() => setSelectedId(op.id)}>
                    Detalhe
                  </Button>
                ),
              },
            ]}
            rows={operations}
          />
          {selectedId !== null ? (
            <ProviderOperationDetailPanel id={selectedId} onChanged={reload} />
          ) : (
            <EmptyState title="Selecione uma operação" hint="O detalhe sanitizado e o log de tentativas aparecem ao lado." />
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProviderOperationDetailPanel({
  id,
  onChanged,
}: {
  id: string;
  onChanged: () => void;
}): React.JSX.Element {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission(PROVIDER_OPERATION_WRITE_PERMISSION);
  const { data, error, loading, reload } = useApi<ProviderOperationDetail>(`/v1/provider/operations/${id}`);
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [outcome, setOutcome] = useState<ProviderResolveOutcome>("FAILED");
  const [note, setNote] = useState("");

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Operação não encontrada" hint="Ela pode ter sido removida deste tenant." />;

  const synthetic = isSyntheticProviderOperation(data);
  // SUCCEEDED/FAILED manuais só existem para adapters sintéticos; proveniência
  // real (`secret-required-v1`) é recusada pelo servidor PARA AMBOS — o efeito
  // só pode ser concluído por readback conclusivo do dispatcher. Sobra UNKNOWN,
  // que apenas mantém a operação em verificação (sem alegação de efeito).
  const outcomes: ProviderResolveOutcome[] = synthetic ? ["SUCCEEDED", "FAILED", "UNKNOWN"] : ["UNKNOWN"];

  const afterChange = (): void => {
    reload();
    onChanged();
  };

  const reconcile = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/v1/provider/operations/${id}/reconcile`, {});
      push("Reconciliação solicitada.");
      afterChange();
    } catch (err) {
      push(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post(`/v1/provider/operations/${id}/resolve`, {
        outcome,
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      push(
        outcome === "UNKNOWN"
          ? "Operação mantida em verificação (efeito desconhecido)."
          : "Resolução registrada.",
      );
      setDialogOpen(false);
      setNote("");
      afterChange();
    } catch (err) {
      push(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Detalhe da operação">
      <p className="cc-mono">{data.id}</p>
      <div className="cc-row">
        <StatusPill status={data.status} />
        <span className="cc-mono">certeza: {data.effectCertainty}</span>
        <span className="cc-mono">{data.action}</span>
      </div>
      <div className="cc-row">
        <span className="cc-muted">
          entidade: {data.entityType} / <span className="cc-mono">{data.entityId}</span>
        </span>
      </div>
      <div className="cc-row">
        <span className="cc-muted">
          adapter: <span className="cc-mono">{data.adapterVersion ?? "—"}</span> · canal:{" "}
          <span className="cc-mono">{data.executionChannel ?? "—"}</span>
        </span>
      </div>
      <h4>Prazos</h4>
      <ul>
        <li>
          Solicitada em {formatDateTime(data.requestedAt)}
        </li>
        <li>Iniciada em {formatDateTime(data.startedAt)}</li>
        <li>Concluída em {formatDateTime(data.completedAt)}</li>
      </ul>
      <h4>Tentativas</h4>
      {data.attempts.length === 0 ? (
        <p className="cc-muted">Sem tentativas registradas.</p>
      ) : (
        <Table
          columns={[
            { header: "#", render: (a) => String(a.attemptNo) },
            { header: "Status", render: (a) => <StatusPill status={a.status} /> },
            { header: "Código de erro", render: (a) => <span className="cc-mono">{a.errorCode ?? "—"}</span> },
            { header: "Iniciada em", render: (a) => formatDateTime(a.startedAt) },
          ]}
          rows={data.attempts.map((a, i) => ({ ...a, id: `${a.attemptNo}-${i}` }))}
        />
      )}
      <p className="cc-muted">Evidência disponível via reconciliação.</p>
      {canWrite ? (
        <div className="cc-row" style={{ marginTop: "0.75rem" }}>
          <Button variant="secondary" disabled={busy} onClick={() => void reconcile()}>
            Solicitar reconciliação
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setOutcome(outcomes[0] ?? "FAILED");
              setDialogOpen(true);
            }}
          >
            Resolver
          </Button>
        </div>
      ) : (
        <p className="cc-muted">
          Você não tem a permissão provider.operation.write; reconciliação e resolução ficam indisponíveis.
        </p>
      )}
      <Dialog title="Resolver operação" open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <Field label="Desfecho">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as ProviderResolveOutcome)}>
            {outcomes.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
        {!synthetic ? (
          <p className="cc-muted">
            Desfechos terminais (SUCCEEDED/FAILED) exigem readback conclusivo pelo dispatcher; o operador só pode
            manter a operação em verificação (UNKNOWN).
          </p>
        ) : null}
        <Field label="Nota do operador (opcional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </Field>
        <Button
          style={{ marginTop: "0.75rem" }}
          disabled={busy}
          onClick={() => {
            void resolve();
          }}
        >
          Confirmar resolução
        </Button>
      </Dialog>
    </Card>
  );
}