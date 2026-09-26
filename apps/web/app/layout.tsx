import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Revenue & Operations Platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
