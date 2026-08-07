// One error type, carrying the status the client should see.
//
// Handlers throw; the router turns these into JSON. Anything that is NOT an
// ApiError is a bug, and becomes a 500 with the detail logged rather than
// returned — a stack trace is not a thing to hand to the internet.

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: unknown) =>
  new ApiError(400, 'bad_request', message, detail);

/** No usable credential. The client should sign in. */
export const unauthorised = (message = 'sign in required') =>
  new ApiError(401, 'unauthorised', message);

/** A valid credential that does not reach this far. Distinct from 401 on
 * purpose: retrying with the same session will never help. */
export const forbidden = (message = 'not allowed') =>
  new ApiError(403, 'forbidden', message);

/**
 * Missing — or present but not yours.
 *
 * Both cases return the same 404 deliberately: a 403 on someone else's
 * project id would confirm that the id exists, which is a membership
 * directory nobody asked us to publish.
 */
export const notFound = (what = 'not found') =>
  new ApiError(404, 'not_found', what);

/** The write was made against a version that has since moved. The caller
 * should re-read and merge rather than retry blindly. */
export const conflict = (message: string, detail?: unknown) =>
  new ApiError(409, 'conflict', message, detail);

export const tooLarge = (message: string) =>
  new ApiError(413, 'too_large', message);

/** Well-formed, but it fails the rules — a manifest with validation errors,
 * an image whose bytes are not the type it claims. */
export const unprocessable = (message: string, detail?: unknown) =>
  new ApiError(422, 'unprocessable', message, detail);

export const tooMany = (message = 'too many requests') =>
  new ApiError(429, 'rate_limited', message);
