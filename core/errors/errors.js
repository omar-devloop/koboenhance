"use strict";
/**
 * core/errors/errors.ts — shared error types for KoboEnhance.
 */
(function () {
    class ApiError extends Error {
        constructor(message, status, detail) {
            super(message);
            this.name = "ApiError";
            this.status = status;
            this.detail = detail;
        }
    }
    class ValidationError extends Error {
        constructor(message) {
            super(message);
            this.name = "ValidationError";
        }
    }
    window.KoboEnhance.errors = {
        ApiError,
        ValidationError,
    };
})();
