import type { Metadata } from "next";
import { headers } from "next/headers";
import "../components/ui/tokens.css";
import { AuthProvider } from "../lib/auth";
import { ToastProvider } from "../components/ui/Toast";

export const metadata: Metadata = {
  title: "Control Center — AI Revenue & Operations Platform",
};

export default async function RootLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  // Passo 2 do SCOPE-CSP-TTL: lê o nonce por-request emitido pelo
  // middleware (`x-nonce`). Sem <script>/<style> inline próprios hoje
  // (zero next/script), nada consome o nonce ainda — o plumbing fica
  // pronto para a migração futura sem mudar o markup agora. A leitura
  // via headers() também torna o layout dinâmico por-request, que é o
  // que um nonce único por resposta exige.
  const nonce = (await headers()).get("x-nonce");
  void nonce;
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
