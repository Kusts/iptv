"use client";

import { Shell } from "../../components/Shell";
import { HitlCenter } from "../../components/HitlCenter";

export default function HitlPage(): React.JSX.Element {
  return (
    <Shell>
      <h1>Centro HITL</h1>
      <p className="cc-muted">Fila de revisão humana agrupada por origem, com SLA e decisão (quando permitido).</p>
      <HitlCenter />
    </Shell>
  );
}
