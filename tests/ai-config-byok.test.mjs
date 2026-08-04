import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptApiKey,
  encryptApiKey,
  maskApiKey,
} from "../src/modules/asistente/server/ai-crypto.ts";

test("encryptApiKey and decryptApiKey roundtrip correctly", async () => {
  const encryptionSecret = "test-only-encryption-secret-with-32-characters";
  const secretKey = "provider-key-example-1234567890abcdefghijklmnopqrstuvwxyz";
  const { cipherText, iv } = await encryptApiKey(secretKey, encryptionSecret);

  assert.ok(cipherText.length > 0);
  assert.ok(iv.length > 0);

  const decrypted = await decryptApiKey(cipherText, iv, encryptionSecret);
  assert.equal(decrypted, secretKey);
});

test("encryptApiKey fails closed without a strong deployment secret", async () => {
  await assert.rejects(
    () => encryptApiKey("provider-key-example", "short"),
    /at least 32 characters/u,
  );
});

test("maskApiKey masks middle characters of API key", () => {
  const key = "provider-key-1234567890";
  const masked = maskApiKey(key);
  assert.equal(masked, "prov••••7890");

  assert.equal(maskApiKey("short"), "••••••••");
  assert.equal(maskApiKey(""), "••••••••");
});
