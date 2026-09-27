"use client";

export function Card({ title, children }: { title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="cc-card">
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}
