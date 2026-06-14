// Error carrying an actionable remediation hint. The CLI prints the hint on
// stderr and the MCP face puts it in the error envelope so a caller always
// knows the next move.
export class PlotholeError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "PlotholeError";
    this.hint = hint;
  }
}
