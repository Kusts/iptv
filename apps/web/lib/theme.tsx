"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: "dark",
  setTheme: () => undefined,
  toggleTheme: () => undefined,
});

const STORAGE_KEY = "iptv.theme";

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (saved === "light" || saved === "dark") {
        setThemeState(saved);
        document.documentElement.setAttribute("data-theme", saved);
        document.documentElement.classList.toggle("dark", saved === "dark");
      } else {
        // Padrão do Control Center IPTV: dark mode de alta precisão
        setThemeState("dark");
        document.documentElement.setAttribute("data-theme", "dark");
        document.documentElement.classList.add("dark");
      }
    } catch {
      // Ignora erro em ambientes sem localStorage
    }
  }, []);

  const setTheme = (next: Theme): void => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      document.documentElement.setAttribute("data-theme", next);
      document.documentElement.classList.toggle("dark", next === "dark");
    } catch {
      // noop
    }
  };

  const toggleTheme = (): void => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  return useContext(ThemeContext);
}
