/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * The Node-only bootstrap lives in `instrumentation-node.ts`; the guard below
 * is evaluated at build time so the Edge compilation never bundles Node
 * modules (node:sqlite, node:fs, …).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
