import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_REIMBURSEMENT_API_BASE_URL ?? "http://localhost:8080";
const authTarget = process.env.VITE_AUTH_BFF_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/api/auth": {
        target: authTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
