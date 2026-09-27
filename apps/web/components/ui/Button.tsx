"use client";

import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
}

export function Button({ variant = "primary", ...rest }: ButtonProps): React.JSX.Element {
  return <button {...rest} className={`cc-btn cc-btn-${variant} ${rest.className ?? ""}`.trim()} />;
}
