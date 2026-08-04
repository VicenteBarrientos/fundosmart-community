export type LatestRequestGate = {
  begin(): number;
  isCurrent(ticket: number): boolean;
};

export function createLatestRequestGate(): LatestRequestGate;
