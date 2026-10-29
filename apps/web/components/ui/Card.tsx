"use client";

export interface CardProps {
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export function Card({ title, className = "", children }: CardProps): React.JSX.Element {
  return (
    <section className={`cc-card ${className}`.trim()}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}
