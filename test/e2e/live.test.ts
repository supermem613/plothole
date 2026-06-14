import test from "node:test";
import { probePrerequisites, runLiveSmoke } from "./harness.js";

// Live end-to-end against a real codespace. Skips cleanly when no codespace is
// reachable (CI, or a host without the codespace gh scope) so the default test
// suite stays green everywhere. Run explicitly with `npm run test:e2e`, or
// `npm run e2e` for verbose hand-running.
test("plothole drives a live codespace end to end", { timeout: 180000 }, async (t) => {
  const probe = await probePrerequisites();
  if (!probe.ready || probe.codespace === undefined) {
    t.skip(probe.reason ?? "no reachable codespace");
    return;
  }
  await runLiveSmoke({ codespace: probe.codespace }, { log: (message) => t.diagnostic(message) });
});
