"use client";

import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

interface FieldProps {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}

export function Field({ label, error, children }: FieldProps): React.JSX.Element {
  return (
    <div className="cc-field">
      <label>
        {label}
        {children}
      </label>
      {error ? <span className="cc-field-error">{error}</span> : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...props} className={`cc-input ${props.className ?? ""}`.trim()} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} className={`cc-select ${props.className ?? ""}`.trim()} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...props} className={`cc-textarea ${props.className ?? ""}`.trim()} rows={props.rows ?? 4} />;
}
