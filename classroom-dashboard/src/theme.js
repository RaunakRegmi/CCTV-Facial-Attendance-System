import { useEffect, useState } from "react";

const STORAGE_KEY = "theme"; // "dark" | "light"

// Saved choice wins; otherwise follow the OS, defaulting to dark.
// Keep in sync with the inline script in index.html.
function readInitialDarkMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved === "dark";
  } catch {
    // storage blocked (private mode, etc.): fall through to the OS preference
  }
  return !window.matchMedia?.("(prefers-color-scheme: light)").matches;
}

// [isDarkMode, setIsDarkMode]: toggles class="dark" on <html> and persists the choice.
export function useTheme() {
  const [isDarkMode, setIsDarkMode] = useState(readInitialDarkMode);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
    try {
      localStorage.setItem(STORAGE_KEY, isDarkMode ? "dark" : "light");
    } catch {
      // not persisted, but the theme still applies for this session
    }
  }, [isDarkMode]);

  return [isDarkMode, setIsDarkMode];
}

// Recharts takes colours as props, not classes, so it gets explicit palettes.
export const CHART_COLORS = {
  dark: {
    grid: "#374151", // gray-700
    tick: "#9ca3af", // gray-400
    axis: "#4b5563", // gray-600
    reference: "#6b7280", // gray-500
    cursor: "#4b5563",
    line: "#818cf8", // indigo-400: bright enough on gray-800
    dotRing: "#1f2937", // gray-800, matches the card
  },
  light: {
    grid: "#e2e8f0", // slate-200
    tick: "#64748b", // slate-500
    axis: "#cbd5e1", // slate-300
    reference: "#94a3b8", // slate-400
    cursor: "#cbd5e1",
    line: "#4f46e5", // indigo-600
    dotRing: "#ffffff",
  },
};
