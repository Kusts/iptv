"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export interface CopySnippetProps {
  text: string;
  slice?: number;
  label?: string;
  className?: string;
}

export function CopySnippet({
  text,
  slice,
  label,
  className = "",
}: CopySnippetProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const display = slice && slice > 0 && text.length > slice ? `${text.slice(0, slice)}…` : text;

  const handleCopy = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== "undefined") {
        try {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("class", "cc-copy-fallback-area");
          document.body.appendChild(textarea);
          textarea.select();
          if (typeof document.execCommand === "function") {
            document.execCommand("copy");
          }
          document.body.removeChild(textarea);
        } catch {
          // jsdom execCommand fallback
        }
      }
    } catch {
      // Falha silenciosa de permissão de clipboard do host
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      className={`cc-copy-snippet ${copied ? "cc-copy-snippet-active" : ""} ${className}`.trim()}
      onClick={(e) => void handleCopy(e)}
      title={copied ? "Copiado para a área de transferência!" : `Clique para copiar: ${text}`}
      aria-label={copied ? "Copiado!" : `Copiar ${label ?? text}`}
    >
      <code className="cc-mono">{display}</code>
      <span className="cc-copy-snippet-icon" aria-hidden="true">
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </span>
      {copied ? <span className="cc-copy-feedback" aria-live="polite">Copiado!</span> : null}
    </button>
  );
}
