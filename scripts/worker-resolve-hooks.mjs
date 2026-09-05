import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const extensions = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"];
const serverOnlyStub = pathToFileURL(path.join(root, "scripts", "server-only-stub.mjs")).href;

function probe(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  for (const ext of extensions) {
    if (existsSync(candidate + ext)) return candidate + ext;
  }
  for (const ext of extensions) {
    const index = path.join(candidate, `index${ext}`);
    if (existsSync(index)) return index;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") {
    return { url: serverOnlyStub, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const resolved = probe(path.join(root, specifier.slice(2)));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const base = path.dirname(fileURLToPath(context.parentURL));
    const resolved = probe(path.resolve(base, specifier));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  return next(specifier, context);
}
