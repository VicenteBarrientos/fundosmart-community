export class DomainRuleError extends Error {
  constructor(message: string, code?: string);
  readonly code: string;
}
