"use client";

import { useState } from "react";
import { api, userMessage } from "../lib/api";
import { clearApiCache } from "../lib/useApi";
import { useOptionalHasPermission } from "../lib/auth";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { EmptyState } from "./ui/States";
import { useToast } from "./ui/Toast";

/**
 * Helpers compartilhados das superfícies revenue-ops (P4a).
 *
 * HARD BOUNDARY: nenhuma regra de domínio vive aqui — apenas transporte de
 * comandos (POST passthrough + `clearApiCache`), gate de permissão e o
 * diálogo de confirmação. O servidor valida, autoriza e decide.
 */
export function PermissionGate({
  permission,
  children,
  label,
}: {
  permission: string;
  children: React.ReactNode;
  label: string;
}): React.JSX.Element {
  const hasPermission = useOptionalHasPermission();
  if (!hasPermission(permission)) {
    return (
      <EmptyState
        title={`Sem permissão para ${label}`}
        hint={`Esta tela exige a permissão ${permission} do seu perfil neste tenant.`}
      />
    );
  }
  return <>{children}</>;
}

export function useRevenueCommand(): {
  busy: boolean;
  run: (path: string, body: unknown, okMessage: string, onDone?: () => void) => Promise<void>;
} {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (path: string, body: unknown, okMessage: string, onDone?: () => void): Promise<void> => {
    setBusy(true);
    try {
      await api.post(path, body);
      clearApiCache();
      push(okMessage);
      onDone?.();
    } catch (err) {
      push(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return { busy, run };
}

export function ConfirmAction({
  title,
  open,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
  children,
}: {
  title: string;
  open: boolean;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Dialog title={title} open={open} onClose={onClose}>
      {children}
      <Button style={{ marginTop: "0.75rem" }} disabled={busy} onClick={onConfirm}>
        {busy ? "Enviando…" : confirmLabel}
      </Button>
    </Dialog>
  );
}
