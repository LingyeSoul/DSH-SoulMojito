// HTTP errors that carry a client-facing status. Route code throws these for
// caller mistakes (bad body, wrong media type, forbidden op) so the API
// wrapper can answer with the intended status instead of a generic 500.

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}
