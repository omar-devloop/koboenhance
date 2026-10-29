/**
 * core/errors/errors.ts — shared error types for KoboEnhance.
 */
(function () {
  class ApiError extends Error {
    declare status?: number;
    declare detail?: string;
    /** How long the server asked us to wait before retrying (ms), read from a
     *  429's "Retry-After" header. Undefined when the server did not say. */
    declare retryAfterMs?: number;

    constructor(message: string, status?: number, detail?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.detail = detail;
    }
  }

  class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  }

  window.KoboEnhance.errors = {
    ApiError,
    ValidationError,
  };
})();