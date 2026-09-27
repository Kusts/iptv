"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch, userMessage } from "./api";

export interface UseApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Hook de leitura com cache simples em memória (chave = path).
 * Desvio MVP deliberado do TanStack Query — ver README (upgrade path).
 */
const cache = new Map<string, unknown>();

export function useApi<T>(path: string | null): UseApiState<T> {
  const [data, setData] = useState<T | null>(() =>
    path !== null && cache.has(path) ? (cache.get(path) as T) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null && !cache.has(path));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) return;
    if (cache.has(path) && nonce === 0) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<T>(path)
      .then((result) => {
        if (cancelled) return;
        cache.set(path, result);
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(userMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  const reload = useCallback(() => {
    if (path !== null) cache.delete(path);
    setData(null);
    setNonce((n) => n + 1);
  }, [path]);

  return { data, error, loading, reload };
}

export function clearApiCache(path?: string): void {
  if (path === undefined) cache.clear();
  else cache.delete(path);
}

export { ApiError };
