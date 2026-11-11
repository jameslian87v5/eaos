/** @type {import('tailwindcss').Config} */
export default {
  content: ["./client/**/*.{js,ts,jsx,tsx,html}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#D83A34",
          hover: "#BE2F2A",
          soft: "#FDEDEA",
        },
        ink: {
          primary: "#1F2937",
          secondary: "#4B5563",
          muted: "#9CA3AF",
        },
        surface: {
          page: "#F6F7F9",
          panel: "#FFFFFF",
        },
        line: {
          subtle: "#E5E7EB",
        },
        // Semantic danger — replaces ad-hoc red-* on user-visible error surfaces.
        danger: {
          DEFAULT: "#DC2626",
          fg: "#B91C1C",
          soft: "#FEF2F2",
          border: "#FECACA",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          '"Noto Sans CJK SC"',
          '"Noto Sans SC"',
          "sans-serif",
        ],
        mono: [
          "SFMono-Regular",
          "ui-monospace",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
