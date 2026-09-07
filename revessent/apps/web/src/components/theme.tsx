"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeName = "light" | "dark" | "amoled";

const ThemeContext = createContext<{ theme: ThemeName; setTheme: (t: ThemeName) => void } | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}

function apply(theme: ThemeName) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>("light");

  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "amoled") setThemeState(attr);
  }, []);

  const setTheme = (t: ThemeName) => {
    setThemeState(t);
    apply(t);
    try {
      localStorage.setItem("rv.theme", t);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

const OPTIONS: { value: ThemeName; label: string; sub: string }[] = [
  { value: "light", label: "Daylight", sub: "ivory" },
  { value: "dark", label: "Evening", sub: "pewter" },
  { value: "amoled", label: "Pure black", sub: "AMOLED" }
];

export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Change theme"
        title="Change theme"
        className="btn btn-glass btn-sm !px-3"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.6" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        </svg>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="glass glass-3 z-50 min-w-[190px] p-1.5"
        >
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeName)}>
            {OPTIONS.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-[13.5px] text-ink outline-none data-[highlighted]:bg-well/70"
              >
                <span>
                  {o.label} <span className="text-ink-4">· {o.sub}</span>
                </span>
                <span className="text-[12px] text-accent-ink">{theme === o.value ? "✓" : ""}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
