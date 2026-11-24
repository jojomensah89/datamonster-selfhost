/** An error whose message is safe to show the caller (agent or owner), with the HTTP status to answer with. */
export class ToolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}
