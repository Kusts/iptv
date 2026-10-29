"use client";

import { useRouter } from "next/navigation";
import { Radio } from "lucide-react";
import { LoginForm } from "../../components/LoginForm";
import { Card } from "../../components/ui/Card";

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  return (
    <main className="cc-content cc-u-login">
      <Card>
        <div className="cc-login-brand">
          <div className="cc-login-logo">
            <Radio size={20} />
          </div>
          <div>
            <h1 className="cc-login-title">Control Center</h1>
            <span className="cc-brand-badge">IPTV Platform</span>
          </div>
        </div>
        <p className="cc-muted cc-login-desc">
          Entre com seu e-mail e senha para operar o tenant.
        </p>
        <LoginForm onSuccess={() => router.replace("/")} />
      </Card>
    </main>
  );
}
