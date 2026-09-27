"use client";

import { toneFor, type StatusTone } from "../../lib/status";

export function Badge({ tone, children }: { tone: StatusTone; children: React.ReactNode }): React.JSX.Element {
  return <span className={`cc-badge cc-badge-${tone}`}>{children}</span>;
}

/** Pílula de status com o mapeamento canônico (apenas apresentação). */
export function StatusPill({ status }: { status: string }): React.JSX.Element {
  return <Badge tone={toneFor(status)}>{status}</Badge>;
}
