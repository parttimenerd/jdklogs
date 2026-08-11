import { defineConfig } from "vite";

// Data lives one level up in the repo's data/ dir; copy it into the build via a symlink-free
// public dir mapping. In dev we serve it through a proxy alias; in prod the CI copies data/ into
// the site's publish dir. We reference it at runtime as `${import.meta.env.BASE_URL}data/...`.
export default defineConfig({
  base: "./",
  publicDir: "public",
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
