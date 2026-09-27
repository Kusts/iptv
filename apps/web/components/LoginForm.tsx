"use client";

import { useState } from "react";
import { useAuth } from "../lib/auth";
import { userMessage } from "../lib/api";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Input";

export function LoginForm({ onSuccess }: { onSuccess?: () => void }): React.JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (email.trim() === "" || password === "") {
      setError("Informe e-mail e senha.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      onSuccess?.();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cc-form" onSubmit={(e) => void submit(e)} aria-label="Entrar">
      <Field label="E-mail" error={null}>
        <Input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@empresa.com.br"
        />
      </Field>
      <Field label="Senha" error={error}>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? "Entrando…" : "Entrar"}
      </Button>
    </form>
  );
}
