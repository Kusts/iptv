"use client";

import { Button } from "./Button";

export function EmptyState({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="cc-empty">
      <p>
        <strong>{title}</strong>
      </p>
      {hint ? <p className="cc-muted">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="cc-error" role="alert">
      <p>
        <strong>Não foi possível carregar.</strong>
      </p>
      <p>{message}</p>
      {onRetry ? <Button variant="secondary" onClick={onRetry}>Tentar de novo</Button> : null}
    </div>
  );
}

export function LoadingSkeleton({ lines = 4 }: { lines?: number }): React.JSX.Element {
  return (
    <div aria-label="Carregando" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="cc-skeleton" style={{ marginBottom: "0.5rem", height: "1.25rem" }} />
      ))}
    </div>
  );
}
