"use client";

import { useState } from "react";
import { api, userMessage, type ChatMessage, type Conversation } from "../lib/api";
import { clearApiCache, useApi } from "../lib/useApi";
import { formatDateTime } from "../lib/money";
import { Button } from "./ui/Button";
import { StatusPill } from "./ui/Badge";
import { Table } from "./ui/Table";
import { EmptyState, ErrorState, LoadingSkeleton } from "./ui/States";
import { Textarea } from "./ui/Input";
import { useToast } from "./ui/Toast";

export function ConversationsPanel(): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ conversations: Conversation[] }>("/v1/communications/conversations");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (loading) return <LoadingSkeleton lines={6} />;
  if (error !== null) return <ErrorState message={error} onRetry={reload} />;
  const rows = data?.conversations ?? [];
  if (rows.length === 0) {
    return <EmptyState title="Nenhuma conversa" hint="Quando chegarem mensagens, elas aparecem aqui." />;
  }
  const selected = rows.find((c) => c.id === selectedId) ?? null;
  return (
    <div className="cc-grid-2">
      <Table
        columns={[
          { header: "Canal", render: (c) => c.channel },
          { header: "Status", render: (c) => <StatusPill status={c.status} /> },
          { header: "Controle", render: (c) => <StatusPill status={c.controlMode} /> },
          { header: "Última msg", render: (c) => formatDateTime(c.lastMessageAt) },
          {
            header: "Ações",
            render: (c) => (
              <Button variant="secondary" onClick={() => setSelectedId(c.id)}>
                Abrir
              </Button>
            ),
          },
        ]}
        rows={rows}
      />
      {selected ? (
        <ConversationDetail key={selected.id} conversation={selected} onChanged={reload} />
      ) : (
        <EmptyState title="Selecione uma conversa" hint="O detalhe e as mensagens aparecem ao lado." />
      )}
    </div>
  );
}

function ConversationDetail({ conversation, onChanged }: { conversation: Conversation; onChanged: () => void }): React.JSX.Element {
  const { data, error, loading, reload } = useApi<{ messages: ChatMessage[] }>(
    `/v1/communications/conversations/${conversation.id}/messages`,
  );
  const { push } = useToast();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, okText: string): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      clearApiCache("/v1/communications/conversations");
      onChanged();
      reload();
      push(okText);
    } catch (err) {
      setActionError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const humanControl = conversation.controlMode === "HUMAN_CONTROL";

  return (
    <section className="cc-card" aria-label="Detalhe da conversa">
      <h3>Conversa</h3>
      <p className="cc-mono">{conversation.id}</p>
      <div className="cc-row">
        <StatusPill status={conversation.status} />
        <StatusPill status={conversation.controlMode} />
        <span className="cc-muted">{conversation.channel}</span>
      </div>
      {loading ? <LoadingSkeleton lines={3} /> : null}
      {error !== null ? <ErrorState message={error} onRetry={reload} /> : null}
      {data ? (
        <ul>
          {data.messages.map((m) => (
            <li key={m.id}>
              <strong>{m.senderType}</strong> <span className="cc-muted">{formatDateTime(m.occurredAt)}</span>{" "}
              {m.deliveryStatus ? <StatusPill status={m.deliveryStatus} /> : null}
              {m.deliveryStatus === "CANCELLED" ? (
                <span role="status" className="cc-badge cc-badge-danger">
                  Entrega cancelada — não execute
                </span>
              ) : null}
              <p>{m.bodyText}</p>
            </li>
          ))}
          {data.messages.length === 0 ? <p className="cc-muted">Sem mensagens ainda.</p> : null}
        </ul>
      ) : null}
      <div className="cc-row">
        <Button
          variant="secondary"
          disabled={busy || humanControl}
          onClick={() => void run(() => api.post(`/v1/communications/conversations/${conversation.id}/assign`, {}), "Conversa assumida.")}
        >
          Assumir
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !humanControl}
          onClick={() => void run(() => api.post(`/v1/communications/conversations/${conversation.id}/release`, {}), "Conversa devolvida.")}
        >
          Devolver
        </Button>
      </div>
      <div className="cc-form" style={{ marginTop: "0.75rem" }}>
        <Textarea
          aria-label="Resposta manual"
          placeholder="Escreva a resposta manual…"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          disabled={busy}
        />
        <Button
          disabled={busy || reply.trim() === ""}
          onClick={() =>
            void run(
              () => api.post(`/v1/communications/conversations/${conversation.id}/send-manual`, { text: reply }),
              "Resposta enviada.",
            ).then(() => setReply(""))
          }
        >
          Enviar resposta
        </Button>
        {actionError ? <span className="cc-field-error">{actionError}</span> : null}
      </div>
    </section>
  );
}
