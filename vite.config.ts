import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const securityHeaders = {
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
};

export default defineConfig({
  plugins: [react()],
  server: {
    headers: securityHeaders,
    proxy: {
      '/api/readings': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  preview: {
    headers: securityHeaders,
    proxy: {
      '/api/readings': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
