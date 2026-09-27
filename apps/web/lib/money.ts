/**
 * Dinheiro em minor units → pt-BR. NUNCA float math: a conversão
 * minor→major é manipulação de string (divisão inteira + resto).
 */

export function minorToMajorParts(amountMinor: string | number | bigint): { reais: string; cents: string; negative: boolean } {
  let raw = typeof amountMinor === "bigint" ? amountMinor.toString() : String(amountMinor).trim();
  let negative = false;
  if (raw.startsWith("-")) {
    negative = true;
    raw = raw.slice(1);
  }
  const digits = raw.replace(/\D/g, "") || "0";
  const padded = digits.padStart(3, "0");
  return {
    reais: padded.slice(0, -2).replace(/^0+(?=\d)/, ""),
    cents: padded.slice(-2),
    negative,
  };
}

export function formatMinor(amountMinor: string | number | bigint, currency = "BRL"): string {
  const { reais, cents, negative } = minorToMajorParts(amountMinor);
  const grouped = Number(reais).toLocaleString("pt-BR");
  const sign = negative ? "-" : "";
  if (currency === "BRL") return `${sign}R$ ${grouped},${cents}`;
  return `${sign}${grouped},${cents} ${currency}`;
}

export function formatDateTime(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
