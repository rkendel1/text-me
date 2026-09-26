export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Machine-readable reason clients can branch on (e.g. session_expired). */
    readonly code?: string,
  ) {
    super(message);
  }
}
