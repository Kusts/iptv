"use client";

import { useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Field, Input, Select } from "../../components/ui/Input";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";

const READ_PERMISSION = "trial.read";
const WRITE_PERMISSION = "trial.write";

interface TrialRow {
  id: string;
  personId: string;
  trialKind: string;
  lifecycleStatus: string;
  technicalOutcome: string | null;
  requestedDurationMinutes: number;
  activatedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface TrialDetail extends TrialRow {
  leadId: string | null;
  previousTrialId: string | null;
  retrialReason: string | null;
  adultContentEnabled: boolean;
  providerAccountId: string | null;
  endedAt: string | null;
  invalidatedReason: string | null;
  attempts: { id: string; attemptType: string; outcome: string; errorCode: string | null; startedAt: string }[];
  technicalResult: {
    id: string;
    installationSuccess: boolean | null;
    authenticationSuccess: boolean | null;
    playbackSuccess: boolean | null;
    bufferingObserved: boolean | null;
    summaryOutcome: string | null;
    assessedAt: string;
  } | null;
}

interface CompatibilitySummary {
  personId: string;
  devices?: unknown;
  apps?: unknown;
  observations?: unknown;
}

export default function TrialsPage(): React.JSX.Element {
  const [status, setStatus] = useState("");
  const qs = status.length > 0 ? `/v1/trials?status=${encodeURIComponent(status)}` : "/v1/trials";
  const { data: list, error: listError, loading: listLoading, reload: listReload } = useApi<{ trials: TrialRow[] }>(qs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { busy, run } = useRevenueCommand();
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  return (
    <Shell>
      <h1>Trials</h1>
      <PermissionGate permission={READ_PERMISSION} label="os trials">
        <div className="cc-row" style={{ marginBottom: "1rem" }}>
          <label className="cc-muted" htmlFor="trial-status">
            Status:
          </label>
          <Select
            id="trial-status"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setSelectedId(null); }}
            style={{ maxWidth: "240px" }}
          >
            <option value="">Todos</option>
            <option value="REQUESTED">REQUESTED</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="ENDED">ENDED</option>
            <option value="CANCELLED">CANCELLED</option>
            <option value="INVALIDATED">INVALIDATED</option>
          </Select>
          {canWrite ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run("/v1/trials/expire-due", {}, "Expiração de trials vencidos solicitada.", listReload)}
            >
              Expirar vencidos
            </Button>
          ) : null}
        </div>
        {listLoading ? <LoadingSkeleton lines={6} /> : null}
        {listError !== null ? <ErrorState message={listError} onRetry={listReload} /> : null}
        {list && list.trials.length === 0 ? (
          <EmptyState title="Nenhum trial" hint="Trials solicitados e retrials aparecem aqui." />
        ) : null}
        {list && list.trials.length > 0 ? (
          <div className="cc-grid-2">
            <Table
              columns={[
                { header: "Tipo", render: (t) => <span className="cc-mono">{t.trialKind}</span> },
                { header: "Ciclo de vida", render: (t) => <StatusPill status={t.lifecycleStatus} /> },
                { header: "Técnico", render: (t) => <StatusPill status={t.technicalOutcome ?? "—"} /> },
                { header: "Expira em", render: (t) => formatDateTime(t.expiresAt) },
                {
                  header: "Ações",
                  render: (t) => (
                    <Button variant="secondary" onClick={() => setSelectedId(t.id)}>
                      Detalhe
                    </Button>
                  ),
                },
              ]}
              rows={list.trials}
            />
            {selectedId ? (
              <TrialDetailPanel key={selectedId} id={selectedId} onChanged={listReload} />
            ) : (
              <EmptyState title="Selecione um trial" hint="Elegibilidade, tentativas e resultado técnico aparecem ao lado." />
            )}
          </div>
        ) : null}
      </PermissionGate>
    </Shell>
  );
}

function TrialDetailPanel({ id, onChanged }: { id: string; onChanged: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<TrialDetail>(`/v1/trials/${id}`);
  const compatPath = data !== null ? `/v1/compatibility/summary?personId=${encodeURIComponent(data.personId)}` : null;
  const { data: compat } = useApi<CompatibilitySummary>(compatPath);
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string; body: unknown } | null>(null);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Trial não encontrado" />;

  const after = (): void => {
    setDialog(null);
    reload();
    onChanged();
  };

  const actions: { path: string; title: string; label: string; body: unknown }[] = [
    { path: `/v1/trials/${id}/end`, title: "Encerrar trial", label: "Encerrar", body: {} },
    { path: `/v1/trials/${id}/cancel`, title: "Cancelar trial", label: "Cancelar", body: {} },
    { path: `/v1/trials/${id}/invalidate`, title: "Invalidar trial", label: "Invalidar", body: {} },
    { path: `/v1/trials/${id}/trust-renewal`, title: "Renovação de confiança", label: "Trust renewal", body: {} },
  ];

  return (
    <Card title="Detalhe do trial">
      <p className="cc-mono">{data.id}</p>
      <div className="cc-row">
        <StatusPill status={data.lifecycleStatus} />
        <StatusPill status={data.technicalOutcome ?? "—"} />
        <span className="cc-muted">{data.requestedDurationMinutes} min</span>
      </div>
      <p className="cc-muted">
        Ativado em {formatDateTime(data.activatedAt)} · Expira em {formatDateTime(data.expiresAt)}
      </p>
      <h4>Tentativas ({data.attempts.length})</h4>
      {data.attempts.length === 0 ? (
        <p className="cc-muted">Sem tentativas registradas.</p>
      ) : (
        <ul>
          {data.attempts.map((a) => (
            <li key={a.id}>
              <span className="cc-mono">{a.attemptType}</span> <StatusPill status={a.outcome} />{" "}
              <span className="cc-muted">{a.errorCode ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
      <h4>Resultado técnico</h4>
      {data.technicalResult === null ? (
        <p className="cc-muted">Sem resultado técnico avaliado.</p>
      ) : (
        <p className="cc-muted">
          Resumo: <span className="cc-mono">{data.technicalResult.summaryOutcome ?? "—"}</span> · avaliado em{" "}
          {formatDateTime(data.technicalResult.assessedAt)}
        </p>
      )}
      <h4>Compatibilidade</h4>
      {compat === null ? (
        <p className="cc-muted">Sem resumo de compatibilidade para esta pessoa.</p>
      ) : (
        <p className="cc-muted">Resumo de dispositivo/app/observações disponível para a pessoa.</p>
      )}
      <CompatibilityLookup />
      {canWrite ? (
        <div className="cc-row" style={{ marginTop: "0.75rem" }}>
          {actions.map((a) => (
            <Button key={a.path} variant="secondary" disabled={busy} onClick={() => setDialog(a)}>
              {a.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="cc-muted">Você não tem a permissão trial.write; ações ficam indisponíveis.</p>
      )}
      <ConfirmAction
        title={dialog?.title ?? ""}
        open={dialog !== null}
        confirmLabel={dialog?.label ?? "Confirmar"}
        busy={busy}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          if (dialog) void run(dialog.path, dialog.body, "Comando de trial enviado.", after);
        }}
      >
        <p className="cc-muted">O servidor valida elegibilidade e estado antes de aplicar. Confirme para enviar.</p>
      </ConfirmAction>
    </Card>
  );
}

function CompatibilityLookup(): React.JSX.Element {
  const [personId, setPersonId] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const { data, error, loading } = useApi<CompatibilitySummary>(
    query !== null ? `/v1/compatibility/summary?personId=${encodeURIComponent(query)}` : null,
  );

  return (
    <div className="cc-form" style={{ marginTop: "0.5rem" }}>
      <Field label="Consultar compatibilidade por pessoa (UUID)">
        <Input value={personId} onChange={(e) => setPersonId(e.target.value)} />
      </Field>
      <Button variant="secondary" onClick={() => setQuery(personId.trim().length > 0 ? personId.trim() : null)}>
        Consultar
      </Button>
      {loading ? <LoadingSkeleton lines={2} /> : null}
      {error !== null ? <p className="cc-field-error">{error}</p> : null}
      {data !== null ? <p className="cc-muted">Resumo carregado para a pessoa informada.</p> : null}
    </div>
  );
}
