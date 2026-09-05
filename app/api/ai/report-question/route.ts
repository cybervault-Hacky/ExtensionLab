import { createAIRoute, questionHash, requiredId } from "@/lib/ai/route-handler";
import { AIError } from "@/lib/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION_CHARS = 500;

/**
 * POST /api/ai/report-question — "Ask about this report". One bounded question
 * about one owned report; no conversation history is kept server-side.
 * Body: { reportId, question }
 */
export const POST = createAIRoute({
  feature: "answer_report_question",
  parse(body) {
    const reportId = requiredId(body, "reportId");
    const question = typeof body.question === "string" ? body.question.replace(/\s+/g, " ").trim() : "";
    if (question.length < 3) throw new AIError("INVALID_INPUT", { message: "Please enter a question about this report." });
    if (question.length > MAX_QUESTION_CHARS) throw new AIError("INVALID_INPUT", { message: `Questions are limited to ${MAX_QUESTION_CHARS} characters.` });
    return { resource: { kind: "report", id: reportId }, focus: { question }, targetId: questionHash(question) };
  },
});
