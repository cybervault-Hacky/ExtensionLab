import { renderTemplate, sendEmail } from "@/lib/email/email-service";
import type { JobHandler } from "../types";

export function createEmailHandler(): JobHandler<"EMAIL"> {
  return {
    type: "EMAIL",
    // Reset links carry a one-time token: drop the payload as soon as the job finishes.
    redactPayloadOnFinish: true,
    async handle(context) {
      const { template, to, variables } = context.payload;
      const message = renderTemplate(template, variables ?? {}, to);
      await sendEmail(message);
      return { delivered: true };
    },
  };
}
