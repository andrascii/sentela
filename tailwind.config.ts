import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef9ff",
          100: "#d9f1ff",
          200: "#bce6ff",
          300: "#8ed7ff",
          400: "#59bfff",
          500: "#33a1ff",
          600: "#1b80f5",
          700: "#1668e1",
          800: "#1854b6",
          900: "#1a498f",
        },
        ink: {
          900: "#0a0f1a",
          800: "#0e1626",
          700: "#141f33",
          600: "#1b2942",
          500: "#26385a",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
