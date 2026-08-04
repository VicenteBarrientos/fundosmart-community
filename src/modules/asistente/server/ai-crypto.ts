async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const normalizedSecret = secret.trim();
  if (normalizedSecret.length < 32) {
    throw new Error("AI_KEYS_ENCRYPTION_SECRET must contain at least 32 characters.");
  }
  const encoder = new TextEncoder();
  const rawKey = await crypto.subtle.digest("SHA-256", encoder.encode(normalizedSecret));
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EncryptedPayload {
  cipherText: string;
  iv: string;
}

export async function encryptApiKey(plainText: string, secret: string): Promise<EncryptedPayload> {
  const key = await getCryptoKey(secret);
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedText = encoder.encode(plainText);

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    encodedText
  );

  const cipherTextHex = Array.from(new Uint8Array(encryptedBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const ivHex = Array.from(ivBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return { cipherText: cipherTextHex, iv: ivHex };
}

export async function decryptApiKey(cipherTextHex: string, ivHex: string, secret: string): Promise<string> {
  const key = await getCryptoKey(secret);

  const ivBytes = new Uint8Array(
    ivHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );
  const cipherBytes = new Uint8Array(
    cipherTextHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    cipherBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length < 8) return "••••••••";
  const start = apiKey.slice(0, 4);
  const end = apiKey.slice(-4);
  return `${start}••••${end}`;
}
