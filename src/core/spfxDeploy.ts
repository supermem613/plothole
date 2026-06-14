// An SPFx rush start serve plugin renders a landing page whose
// spfxDebugQueryString slot is the authoritative "can I actually use this dev
// server" signal. When the served scenario built and deployed to the local dev
// server that slot holds a real "?debug=true&loader=...&debugManifestsFile=..."
// query string. When the closure pulled in deploy-only projects the codespace
// cannot upload, those uploads 403 and the scenario is not served: the same slot
// renders the literal "(Not Deployed)". That marker is distinct from the generic
// rushstack FAILURE banner, which is why this classifier is its own gate.
//
// INVARIANT: the literal "(Not Deployed)" also appears on a HEALTHY page in
// unrelated demo and size-auditor cards, so a page-wide scan would call a healthy
// server failed. The classifier must read only the spfxDebugQueryString element.
//
// This marker is SPFx specific, so it lives here and never in the generic
// rush arg-builder.

export interface SpfxDeployStatus {
  // True only when the served landing page advertises a real debug query string.
  // A handoff to a browser or curl is safe only when this is true.
  deployed: boolean;
  // The query string the page advertised, present only when deployed.
  debugQueryString?: string;
  // Why the page was classified this way, so a failed assert reads as a
  // BUILD/DEPLOY problem and is never mistaken for an auth or port-forward issue.
  reason: string;
  // Set to false by the fetch layer ONLY when the landing page could not be
  // fetched at all, e.g. an unreachable port or a missing curl, as opposed to a
  // page that was fetched and classified as not deployed. The classifier never
  // sets it. A consumer uses it to tell a transport failure apart from a closure
  // failure, since the two need different remediation.
  reachable?: boolean;
}

const SPFX_DEBUG_SLOT = /<code id="spfxDebugQueryString">([\s\S]*?)<\/code>/i;

export function classifySpfxDeploy(html: string): SpfxDeployStatus {
  const match = SPFX_DEBUG_SLOT.exec(html);
  if (match === null) {
    return {
      deployed: false,
      reason:
        "the served page has no spfxDebugQueryString element, so it is not a healthy SPFx rush start landing page; the dev server may not be up or the scenario did not render",
    };
  }
  const value = match[1].trim();
  if (value.startsWith("?")) {
    return {
      deployed: true,
      debugQueryString: value,
      reason: "the served page advertises a debug query string, so the scenario deployed to the dev server",
    };
  }
  return {
    deployed: false,
    reason: `the spfxDebugQueryString slot reads "${value || "(empty)"}", so the scenario did not deploy to the dev server; this is a BUILD/DEPLOY failure, not an auth or port-forward problem`,
  };
}
