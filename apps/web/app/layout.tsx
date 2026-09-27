import type { Metadata } from "next";
import "../components/ui/tokens.css";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";

export const metadata: Metadata = {
  title: "Control Center — AI Revenue & Operations Platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body className="cc-body">
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
