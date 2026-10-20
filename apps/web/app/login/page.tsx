"use client";

import { useRouter } from "next/navigation";
import { LoginForm } from "../../components/LoginForm";

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  return (
    <main className="cc-content cc-u-login">
      <h1>Control Center</h1>
      <p className="cc-muted">Entre com seu e-mail e senha para operar o tenant.</p>
      <LoginForm onSuccess={() => router.replace("/")} />
    </main>
  );
}
