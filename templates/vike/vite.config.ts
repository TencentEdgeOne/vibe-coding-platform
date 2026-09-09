import vike from "vike/plugin";
import { defineConfig } from "vite";
import edgeone from "@edgeone/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [vike(), edgeone(), react()],
});
