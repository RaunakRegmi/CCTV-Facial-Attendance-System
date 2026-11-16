import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Inter (loaded in index.html), then the system SF Pro stack
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Text"',
          ...defaultTheme.fontFamily.sans,
        ],
      },
      boxShadow: {
        // Tailwind v3 has no shadow-xs; minimal elevation for white cards
        xs: "0 1px 2px 0 rgb(15 23 42 / 0.04)",
      },
    },
  },
  plugins: [],
};
