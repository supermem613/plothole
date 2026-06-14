import { forwardVerb } from "../core/verbs.js";
import { presentForward } from "../present.js";
import { emitError, emitSuccess } from "./emit.js";

// forward bridges a codespace TCP port to a host port so host tools can reach a
// codespace service. With no flags it starts a forward for the given port; --list
// reports active forwards and --stop tears one down.
export async function forwardCommand(
  port: string | undefined,
  opts: { codespace?: string; localPort?: string; list?: boolean; stop?: string },
): Promise<void> {
  try {
    const result = await forwardVerb({
      codespace: opts.codespace,
      port: port === undefined ? undefined : Number.parseInt(port, 10),
      localPort: opts.localPort === undefined ? undefined : Number.parseInt(opts.localPort, 10),
      list: opts.list,
      stop: opts.stop === undefined ? undefined : Number.parseInt(opts.stop, 10),
    });
    emitSuccess("forward", presentForward(result));
  } catch (err) {
    emitError("forward", err);
  }
}
