import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Shell } from "../components/Shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/support",
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...props }: { href: string; children: ReactNode; onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void; [key: string]: unknown }) => (
    <a href={href} onClick={(event) => { event.preventDefault(); onClick?.(event); }} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: "user-1", email: "operator@example.test", displayName: null },
    tenants: [{ tenantId: "tenant-1", tenantName: "Tenant de teste", roleKey: "tenant_owner" }],
    activeTenantId: "tenant-1",
    loading: false,
    logout: vi.fn(),
    switchTenant: vi.fn(),
  }),
}));

vi.mock("../lib/theme", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }),
}));

vi.mock("../components/CopilotWidget", () => ({
  CopilotWidget: () => null,
}));

describe("Shell mobile navigation", () => {
  it("opens the navigation disclosure and closes it after choosing a route", () => {
    render(
      <Shell>
        <p>Conteúdo da tela</p>
      </Shell>,
    );

    const toggle = screen.getByRole("button", { name: "Abrir navegação principal" });
    const navigation = screen.getByRole("navigation", { name: "Navegação principal" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(navigation.className).toContain("cc-sidebar-open");
    fireEvent.transitionEnd(navigation, { propertyName: "transform" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Painel" }));

    fireEvent.click(screen.getByRole("link", { name: "Suporte" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(navigation.className).not.toContain("cc-sidebar-open");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes with Escape and returns focus to the navigation toggle", () => {
    render(
      <Shell>
        <p>Conteúdo da tela</p>
      </Shell>,
    );

    const toggle = screen.getByRole("button", { name: "Abrir navegação principal" });
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });
});
