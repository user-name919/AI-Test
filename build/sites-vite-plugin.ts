import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(sourceRoot?: string): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const serverDirectory = resolve(root, "dist", "server");
      const hostingConfig = resolve(sourceRoot ?? root, ".openai", "hosting.json");
      const drizzleSource = resolve(sourceRoot ?? root, "drizzle");
      const workerEntry = resolve(sourceRoot ?? root, "worker", "index.js");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });
      await mkdir(serverDirectory, { recursive: true });

      if (await exists(workerEntry)) {
        await cp(workerEntry, resolve(serverDirectory, "index.js"));
      }

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}
