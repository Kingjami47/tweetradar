"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export const THEME_STORAGE_KEY = "tweetradar-theme";

/**
 * Sun/Moon theme switch — ZERO React state by design.
 *
 * Both icons render always; pure CSS (globals.css .theme-icon-*) picks the
 * visible one from the current `html.dark` class. Toggling flips the class on
 * <html> and persists the choice in localStorage ("tweetradar-theme").
 * layout.tsx runs a pre-paint script that applies the stored choice before
 * first paint — no flash, no hydration mismatch, no setState-in-effect.
 */
export function ThemeToggle() {
  const toggle = () => {
    const isDark = document.documentElement.classList.contains("dark");
    const next = isDark ? "light" : "dark";
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — theme still toggles for this visit */
    }
    document.documentElement.classList.toggle("dark", next === "dark");
  };

  return (
    <Button
      size="icon"
      variant="outline"
      onClick={toggle}
      aria-label="Toggle dark / light mode"
      title="Toggle dark / light mode"
      className="h-9 w-9 border-border bg-card/60 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Sun className="theme-icon-sun h-4 w-4" aria-hidden />
      <Moon className="theme-icon-moon h-4 w-4" aria-hidden />
    </Button>
  );
}
