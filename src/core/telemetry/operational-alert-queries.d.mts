import type {
  OperationalAlertEnvironment,
  OperationalAlertSnapshotV1,
} from "./operational-alert-policy.mjs";

export const OPERATIONAL_ALERT_DATASETS: Readonly<
  Record<OperationalAlertEnvironment, string>
>;

export class OperationalAlertQueryError extends TypeError {
  readonly code: string;
  constructor(code: string);
}

export type OperationalAlertQuery = Readonly<{
  startedAt: string;
  endedAt: string;
  sql: string;
}>;

export type OperationalAlertQueryBundle = Readonly<{
  environment: OperationalAlertEnvironment;
  endedAt: string;
  request: OperationalAlertQuery;
  integrity: OperationalAlertQuery;
}>;

export function buildOperationalAlertQueries(input: Readonly<{
  environment: OperationalAlertEnvironment;
  endedAt: string;
}>): OperationalAlertQueryBundle;

export function parseOperationalAlertQueryResponses(input: Readonly<{
  environment: OperationalAlertEnvironment;
  endedAt: string;
  requestResponse: string;
  integrityResponse: string;
}>): OperationalAlertSnapshotV1;
