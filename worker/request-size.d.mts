export const DEFAULT_API_BODY_LIMIT_BYTES: number;
export const IMPORT_BODY_LIMIT_BYTES: number;
export const RESTORE_BODY_LIMIT_BYTES: number;
export interface ApiMutationSizeResult {
  request: Request;
  rejection: Response | null;
}
export function enforceApiMutationSize(request: Request): Promise<ApiMutationSizeResult>;
