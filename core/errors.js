// One error type for the whole app. `code` is stable and safe to show/branch on.
export class TitenError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'TitenError';
    this.code = code;
    if (status) this.status = status;
  }
}

export const ErrorCodes = {
  NO_KEY: 'NO_KEY',
  BAD_KEY: 'BAD_KEY',
  NO_CREDIT: 'NO_CREDIT',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  LLM_ERROR: 'LLM_ERROR',
  BAD_OUTPUT: 'BAD_OUTPUT',
  BAD_INPUT: 'BAD_INPUT',
  UNREADABLE: 'UNREADABLE',
  FETCH_FAILED: 'FETCH_FAILED',
  BLOCKED_HOST: 'BLOCKED_HOST',
};
