export type GoogleIdentity = {
  provider: "google";
  providerSubject: string;
  email: string;
  normalizedEmail: string;
  displayName: string;
};

export function googleAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string;

export function exchangeGoogleAuthorizationCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;

export function verifyGoogleIdToken(idToken: string, options: {
  clientId: string;
  nonce: string;
  key?: Parameters<typeof import("jose").jwtVerify>[1];
  currentDate?: Date;
}): Promise<GoogleIdentity>;
