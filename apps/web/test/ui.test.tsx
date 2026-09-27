import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { Field, Input, Select, Textarea } from "../components/ui/Input";
import { Card } from "../components/ui/Card";
import { Table } from "../components/ui/Table";
import { Badge, StatusPill } from "../components/ui/Badge";
import { EmptyState, ErrorState, LoadingSkeleton } from "../components/ui/States";
import { Dialog } from "../components/ui/Dialog";
import { ToastProvider, useToast } from "../components/ui/Toast";

describe("Button", () => {
  it("renderiza e responde ao clique", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Salvar</Button>);
    const btn = screen.getByRole("button", { name: "Salvar" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("desabilitado não dispara clique", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Salvar</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Input/Select/Textarea", () => {
  it("digita no input e exibe erro do field", () => {
    render(
      <Field label="E-mail" error="Obrigatório">
        <Input aria-label="E-mail" placeholder="mail" />
      </Field>,
    );
    const input = screen.getByLabelText("E-mail");
    fireEvent.change(input, { target: { value: "a@b.co" } });
    expect(input).toHaveValue("a@b.co");
    expect(screen.getByText("Obrigatório")).toBeTruthy();
  });

  it("troca a opção do select", () => {
    render(
      <Select aria-label="Opção" defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const select = screen.getByLabelText("Opção") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "b" } });
    expect(select.value).toBe("b");
  });

  it("digita no textarea", () => {
    render(<Textarea aria-label="Mensagem" />);
    const area = screen.getByLabelText("Mensagem");
    fireEvent.change(area, { target: { value: "oi" } });
    expect(area).toHaveValue("oi");
  });
});

describe("Card/Table/Badge", () => {
  it("card exibe título e conteúdo", () => {
    render(<Card title="Título"><p>corpo</p></Card>);
    expect(screen.getByText("Título")).toBeTruthy();
    expect(screen.getByText("corpo")).toBeTruthy();
  });

  it("table renderiza linhas e cabeçalho fixo", () => {
    render(
      <Table
        columns={[{ header: "Nome", render: (r) => r.name }]}
        rows={[{ id: "1", name: "Ana" }]}
      />,
    );
    expect(screen.getByText("Nome")).toBeTruthy();
    expect(screen.getByText("Ana")).toBeTruthy();
  });

  it("status pill mapeia ACTIVE→success e FAILED→danger", () => {
    const { container } = render(
      <>
        <StatusPill status="ACTIVE" />
        <StatusPill status="FAILED" />
        <Badge tone="info">x</Badge>
      </>,
    );
    const pills = container.querySelectorAll(".cc-badge");
    expect(pills[0]?.className).toContain("cc-badge-success");
    expect(pills[1]?.className).toContain("cc-badge-danger");
  });
});

describe("states", () => {
  it("empty, error com retry e skeleton", () => {
    const onRetry = vi.fn();
    render(
      <>
        <EmptyState title="Vazio" hint="dica" />
        <ErrorState message="falhou" onRetry={onRetry} />
        <LoadingSkeleton lines={2} />
      </>,
    );
    expect(screen.getByText("Vazio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Carregando")).toBeTruthy();
  });
});

describe("Dialog", () => {
  it("abre, fecha no botão e no Escape", () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return <Dialog title="Ajuda" open={open} onClose={() => setOpen(false)}>texto</Dialog>;
    }
    render(<Harness />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Toast", () => {
  it("exibe mensagem após push", () => {
    function Harness(): React.JSX.Element {
      const { push } = useToast();
      return <Button onClick={() => push("feito!")}>ok</Button>;
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "ok" }));
    expect(screen.getByText("feito!")).toBeTruthy();
  });
});
