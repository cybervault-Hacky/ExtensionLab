import "server-only";
import type { JobHandler } from "../types";
import { runOrganizationExport } from "@/lib/organizations/export";

/** ORG_EXPORT handler: gathers organization metadata into a storage artifact. */
export function createOrgExportHandler(): JobHandler<"ORG_EXPORT"> {
  return {
    type: "ORG_EXPORT",
    async handle(context) {
      const result = await runOrganizationExport(context.payload.exportId, context.payload.organizationId);
      return result;
    },
    async cancel() {
      // The export row records its own state; a cancelled attempt stays
      // "running" until the sweep expires it — never marked completed.
    },
  };
}
