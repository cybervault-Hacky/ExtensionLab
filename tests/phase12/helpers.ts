import { setAIProviderForTests } from "@/lib/ai/provider";
import { createFakeAIProvider, type FakeAIProvider } from "@/lib/ai/providers/fake";
import { resetConcurrencyForTests } from "@/lib/ai/limits";
import {
  FakeDriver,
  FakeRunner,
  fixtureZip,
  makeUser,
  setupHarness,
  startReadySession,
  waitFor,
  type Harness,
} from "../phase11/helpers";

export { FakeDriver, FakeRunner, fixtureZip, makeUser, startReadySession, waitFor };
export type { Harness };

/**
 * Phase 12 harness: Phase 11 browser isolation (throw-away SQLite + fake
 * sandbox containers speaking the real runner protocol) with the deterministic
 * fake AI provider pinned, so evidence/recipe/status tests can also exercise
 * the real AI explanation pipeline without network access.
 */
export function setupPhase12Harness(env: Record<string, string> = {}): Harness & { ai: FakeAIProvider } {
  const harness = setupHarness({ AI_PROVIDER: "fake", ...env });
  const ai = createFakeAIProvider();
  setAIProviderForTests(ai);
  resetConcurrencyForTests();
  return {
    ...harness,
    ai,
    teardown() {
      setAIProviderForTests(null);
      resetConcurrencyForTests();
      harness.teardown();
    },
  };
}
