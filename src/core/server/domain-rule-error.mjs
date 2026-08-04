export class DomainRuleError extends Error {
  constructor(message, code = "DOMAIN_RULE_VIOLATION") {
    super(message);
    this.name = "DomainRuleError";
    this.code = code;
  }
}
