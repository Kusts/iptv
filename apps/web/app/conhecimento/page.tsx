"use client";

import { Shell } from "../../components/Shell";
import { KnowledgeQueues } from "../../components/KnowledgeQueues";
import { ToastProvider } from "../../components/ui/Toast";

export default function ConhecimentoPage(): React.JSX.Element {
  return (
    <Shell>
      <ToastProvider>
        <h1>Conhecimento</h1>
        <KnowledgeQueues />
      </ToastProvider>
    </Shell>
  );
}
