import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __SYNCVAULT_SERVER_URL__: JSON.stringify("http://localhost:8787"),
  },
});