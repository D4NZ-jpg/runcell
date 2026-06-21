/**
 * Base class for all errors thrown by runcell.
 */
export class RuncellError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuncellError';
  }
}

/**
 * Thrown when an agent option or run option fails validation before any work
 * is started (e.g. an unsafe workspace path or a missing model).
 */
export class InvalidOptionError extends RuncellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidOptionError';
  }
}

/**
 * Thrown when the agent finishes without producing a valid `submitResult`
 * payload, even after the allowed repair turns.
 */
export class IncompleteResultError extends RuncellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IncompleteResultError';
  }
}

/**
 * Thrown when credentials are misconfigured for the current environment
 * (for example, local file credentials used in production without opt-in).
 */
export class CredentialError extends RuncellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialError';
  }
}

export class NotImplementedError extends RuncellError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
