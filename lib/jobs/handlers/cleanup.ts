import { runCleanup } from "../cleanup";
import type { JobHandler } from "../types";

export function createCleanupHandler(): JobHandler<"ARTIFACT_CLEANUP"> {
  return {
    type: "ARTIFACT_CLEANUP",
    async handle(context) {
      const report = await runCleanup(context.payload);
      return { ...report } as unknown as Record<string, unknown>;
    },
  };
}
