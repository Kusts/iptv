"use client";

import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell";
import { ConfirmAction, PermissionGate, useRevenueCommand } from "../../components/RevenueOps";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { StatusPill } from "../../components/ui/Badge";
import { Table } from "../../components/ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "../../components/ui/States";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select } from "../../components/ui/Input";
import { useToast } from "../../components/ui/Toast";
import { useApi } from "../../lib/useApi";
import { formatDateTime } from "../../lib/money";
import { useOptionalHasPermission } from "../../lib/auth";
import { api, userMessage } from "../../lib/api";

const READ_PERMISSION = "trial.read";
const WRITE_PERMISSION = "trial.write";
const CRM_PERSON_READ_PERMISSION = "crm.person.read";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface PersonOption {
  id: string;
  canonicalName: string | null;
}

function personLabel(p: PersonOption): string {
  return p.canonicalName !== null && p.canonicalName.trim().length > 0 ? p.canonicalName : p.id.slice(0, 8);
}

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
  const { data: list, error: listError, loading: listLoading, reload: listReload, refresh: listRefresh } = useApi<{ trials: TrialRow[] }>(qs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const { busy, run } = useRevenueCommand();
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  const handleTrialCreated = (newId?: string): void => {
    listReload();
    if (newId) setSelectedId(newId);
  };

  return (
    <Shell>
      <h1>Trials</h1>
      <PermissionGate permission={READ_PERMISSION} label="os trials">
        <div className="cc-row cc-u-mb-4" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div className="cc-row">
            <label className="cc-muted" htmlFor="trial-status">
              Status:
            </label>
            <Select
              id="trial-status"
              value={status}
              onChange={(e) => { setStatus(e.target.value); setSelectedId(null); }}
              className="cc-u-maxw-240"
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
          {canWrite ? (
            <Button onClick={() => setCreateOpen(true)}>
              Novo trial
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
              searchable
              searchPlaceholder="Filtrar trials…"
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
              <TrialDetailPanel key={selectedId} id={selectedId} onChanged={listRefresh} />
            ) : (
              <EmptyState title="Selecione um trial" hint="Elegibilidade, tentativas e resultado técnico aparecem ao lado." />
            )}
          </div>
        ) : null}
        {canWrite ? (
          <CreateTrialDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            onDone={handleTrialCreated}
          />
        ) : null}
      </PermissionGate>
    </Shell>
  );
}

function TrialDetailPanel({ id, onChanged }: { id: string; onChanged: () => void }): React.JSX.Element {
  const { data, error, loading, reload, refresh } = useApi<TrialDetail>(`/v1/trials/${id}`);
  const compatPath = data !== null ? `/v1/compatibility/summary?personId=${encodeURIComponent(data.personId)}` : null;
  const { data: compat } = useApi<CompatibilitySummary>(compatPath);
  const { busy, run } = useRevenueCommand();
  const [dialog, setDialog] = useState<{ path: string; title: string; label: string; body: unknown } | null>(null);
  const [retrialOpen, setRetrialOpen] = useState(false);
  const hasPermission = useOptionalHasPermission();
  const canWrite = hasPermission(WRITE_PERMISSION);

  if (loading) return <LoadingSkeleton lines={4} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  if (data === null) return <EmptyState title="Trial não encontrado" />;

  const after = (): void => {
    setDialog(null);
    refresh();
    onChanged();
  };

  const handleRetrialDone = (): void => {
    refresh();
    onChanged();
  };

  const isTerminal = data.lifecycleStatus === "ENDED" || data.lifecycleStatus === "INVALIDATED";

  const actions: { path: string; title: string; label: string; body: unknown }[] = [
    { path: `/v1/trials/${id}/end`, title: "Encerrar trial", label: "Encerrar", body: {} },
    { path: `/v1/trials/${id}/cancel`, title: "Cancelar trial", label: "Cancelar", body: { reason: "Cancelado via painel de operações" } },
    { path: `/v1/trials/${id}/invalidate`, title: "Invalidar trial", label: "Invalidar", body: { reason: "Invalidado via painel de operações" } },
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
      {data.adultContentEnabled ? (
        <p className="cc-muted">Conteúdo adulto: <strong>Habilitado</strong></p>
      ) : null}
      {data.previousTrialId ? (
        <p className="cc-muted">Retrial do trial anterior: <span className="cc-mono">{data.previousTrialId.slice(0, 8)}…</span></p>
      ) : null}
      {data.retrialReason ? (
        <p className="cc-muted">Justificativa do retrial: {data.retrialReason}</p>
      ) : null}
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
        <div className="cc-row cc-u-mt-3">
          {actions.map((a) => (
            <Button key={a.path} variant="secondary" disabled={busy} onClick={() => setDialog(a)}>
              {a.label}
            </Button>
          ))}
          {isTerminal ? (
            <Button disabled={busy} onClick={() => setRetrialOpen(true)}>
              Solicitar retrial
            </Button>
          ) : null}
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
      {canWrite && isTerminal ? (
        <RequestRetrialDialog
          open={retrialOpen}
          previousTrial={data}
          onClose={() => setRetrialOpen(false)}
          onDone={handleRetrialDone}
        />
      ) : null}
    </Card>
  );
}

function CreateTrialDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (newId?: string) => void;
}): React.JSX.Element {
  const { push } = useToast();
  const hasPermission = useOptionalHasPermission();
  const canListPersons = hasPermission(CRM_PERSON_READ_PERMISSION);
  const personsQuery = useApi<{ persons: PersonOption[] }>(canListPersons ? "/v1/crm/persons" : null);
  const persons = personsQuery.data?.persons ?? null;
  const personsAvailable = canListPersons && persons !== null && personsQuery.error === null;
  const personList: PersonOption[] | null = personsAvailable ? persons : null;

  const [personId, setPersonId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [adultContentEnabled, setAdultContentEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (personList && personList.length === 1 && personList[0]) {
      setPersonId(personList[0].id);
    }
  }, [personList]);

  if (!open) return <></>;

  const showPersonSelect = personList !== null && personList.length > 1;
  const singleAuto = personList !== null && personList.length === 1 ? personList[0] : null;
  const showManualPerson = !personsAvailable || personList === null || personList.length === 0;

  const handleSubmit = async (): Promise<void> => {
    setFormError(null);
    setApiError(null);

    const trimmedPerson = (personId || (singleAuto ? singleAuto.id : "")).trim();
    if (!UUID_RE.test(trimmedPerson)) {
      setFormError("Informe um UUID válido para a pessoa.");
      return;
    }

    const trimmedLead = leadId.trim();
    if (trimmedLead.length > 0 && !UUID_RE.test(trimmedLead)) {
      setFormError("O ID do lead deve ser um UUID válido (ou deixe em branco).");
      return;
    }

    const dur = parseInt(durationMinutes, 10);
    if (Number.isNaN(dur) || dur <= 0 || dur > 1440) {
      setFormError("A duração deve ser entre 1 e 1440 minutos.");
      return;
    }

    setBusy(true);
    try {
      const res = await api.post<{ id: string | null; status: string; reviewRequestId?: string }>(
        "/v1/trials/request",
        {
          personId: trimmedPerson,
          durationMinutes: dur,
          adultContentEnabled,
          ...(trimmedLead.length > 0 ? { leadId: trimmedLead } : {}),
        },
      );

      if (res.status === "PENDING_REVIEW") {
        push("Trial encaminhado para revisão humana (HITL).");
      } else {
        push("Trial solicitado com sucesso!");
      }
      onClose();
      onDone(res.id ?? undefined);
    } catch (err) {
      setApiError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Novo trial" onClose={onClose}>
      <div className="cc-form">
        {singleAuto ? (
          <p className="cc-muted">
            Trial para {personLabel(singleAuto)} (seleção automática).
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

        <Field label="Duração">
          <Select
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.target.value)}
            disabled={busy}
          >
            <option value="30">30 minutos</option>
            <option value="60">1 hora (padrão)</option>
            <option value="180">3 horas</option>
            <option value="360">6 horas</option>
            <option value="1440">24 horas</option>
          </Select>
        </Field>

        <Field label="ID do lead (opcional)">
          <Input
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            disabled={busy}
            placeholder="UUID do lead associado"
          />
        </Field>

        <div className="cc-field cc-u-mt-2">
          <label className="cc-row" style={{ alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={adultContentEnabled}
              onChange={(e) => setAdultContentEnabled(e.target.checked)}
              disabled={busy}
            />
            <span>Habilitar conteúdo adulto</span>
          </label>
        </div>

        {formError ? <p className="cc-field-error">{formError}</p> : null}
        {apiError ? <p className="cc-field-error">{apiError}</p> : null}

        <div className="cc-row cc-u-mt-4">
          <Button disabled={busy} onClick={() => void handleSubmit()}>
            {busy ? "Solicitando…" : "Solicitar trial"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RequestRetrialDialog({
  open,
  previousTrial,
  onClose,
  onDone,
}: {
  open: boolean;
  previousTrial: TrialDetail;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const { push } = useToast();
  const [reason, setReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [adultContentEnabled, setAdultContentEnabled] = useState(previousTrial.adultContentEnabled);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  if (!open) return <></>;

  const handleSubmit = async (): Promise<void> => {
    setFormError(null);
    setApiError(null);

    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      setFormError("Informe a justificativa para o retrial (obrigatória).");
      return;
    }
    if (trimmedReason.length > 500) {
      setFormError("A justificativa deve ter no máximo 500 caracteres.");
      return;
    }

    const dur = parseInt(durationMinutes, 10);
    if (Number.isNaN(dur) || dur <= 0 || dur > 1440) {
      setFormError("A duração deve ser entre 1 e 1440 minutos.");
      return;
    }

    setBusy(true);
    try {
      const res = await api.post<{ id: string | null; status: string; reviewRequestId?: string }>(
        "/v1/trials/retrials",
        {
          previousTrialId: previousTrial.id,
          reason: trimmedReason,
          durationMinutes: dur,
          adultContentEnabled,
        },
      );

      if (res.status === "PENDING_REVIEW") {
        push("Retrial encaminhado para revisão humana (HITL).");
      } else {
        push("Retrial solicitado com sucesso!");
      }
      onClose();
      onDone();
    } catch (err) {
      setApiError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="Solicitar retrial" onClose={onClose}>
      <div className="cc-form">
        <p className="cc-muted">
          Trial anterior: {previousTrial.id} ({previousTrial.lifecycleStatus})
        </p>

        <Field label="Justificativa do retrial (obrigatória)">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            placeholder="Ex.: Instabilidade de rota no primeiro teste; reteste aprovado"
          />
        </Field>

        <Field label="Duração">
          <Select
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(e.target.value)}
            disabled={busy}
          >
            <option value="30">30 minutos</option>
            <option value="60">1 hora (padrão)</option>
            <option value="180">3 horas</option>
            <option value="360">6 horas</option>
            <option value="1440">24 horas</option>
          </Select>
        </Field>

        <div className="cc-field cc-u-mt-2">
          <label className="cc-row" style={{ alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={adultContentEnabled}
              onChange={(e) => setAdultContentEnabled(e.target.checked)}
              disabled={busy}
            />
            <span>Habilitar conteúdo adulto</span>
          </label>
        </div>

        {formError ? <p className="cc-field-error">{formError}</p> : null}
        {apiError ? <p className="cc-field-error">{apiError}</p> : null}

        <div className="cc-row cc-u-mt-4">
          <Button disabled={busy} onClick={() => void handleSubmit()}>
            {busy ? "Enviando…" : "Confirmar retrial"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CompatibilityLookup(): React.JSX.Element {
  const [personId, setPersonId] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const { data, error, loading } = useApi<CompatibilitySummary>(
    query !== null ? `/v1/compatibility/summary?personId=${encodeURIComponent(query)}` : null,
  );

  return (
    <div className="cc-form cc-u-mt-2">
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
