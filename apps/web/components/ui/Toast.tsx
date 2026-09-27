"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

interface Toast {
  id: number;
  text: string;
}

const ToastContext = createContext<{ push: (text: string) => void }>({ push: () => undefined });

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cc-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="cc-toast">
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): { push: (text: string) => void } {
  return useContext(ToastContext);
}
