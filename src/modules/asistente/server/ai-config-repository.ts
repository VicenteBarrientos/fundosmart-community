import { getDb } from "@/db";
import { organizationAiConfigs, type AiProviderKey } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { decryptApiKey, encryptApiKey, maskApiKey } from "./ai-crypto";

export interface OrganizationAiConfigDto {
  id: string;
  organizationId: string;
  provider: AiProviderKey;
  maskedApiKey: string;
  defaultModel: string;
  isActive: boolean;
  updatedAt: string;
  updatedBy: string;
}

export async function getActiveOrganizationAiConfig(
  organizationId: string
): Promise<{ provider: AiProviderKey; apiKey: string; defaultModel: string } | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(organizationAiConfigs)
    .where(
      and(
        eq(organizationAiConfigs.organizationId, organizationId),
        eq(organizationAiConfigs.isActive, true)
      )
    )
    .limit(1);

  if (!row) return null;

  try {
    const plainApiKey = await decryptApiKey(
      row.encryptedApiKey,
      row.encryptedKeyIv,
      requiredEncryptionSecret(),
    );
    return {
      provider: row.provider as AiProviderKey,
      apiKey: plainApiKey,
      defaultModel: row.defaultModel,
    };
  } catch (err) {
    console.error("Error decrypting organization AI API key:", err);
    return null;
  }
}

export async function getOrganizationAiConfigSummary(
  organizationId: string
): Promise<OrganizationAiConfigDto | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(organizationAiConfigs)
    .where(eq(organizationAiConfigs.organizationId, organizationId))
    .limit(1);

  if (!row) return null;

  let maskedKey = "••••••••";
  try {
    const plainApiKey = await decryptApiKey(
      row.encryptedApiKey,
      row.encryptedKeyIv,
      requiredEncryptionSecret(),
    );
    maskedKey = maskApiKey(plainApiKey);
  } catch {
    maskedKey = "••••••••";
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider as AiProviderKey,
    maskedApiKey: maskedKey,
    defaultModel: row.defaultModel,
    isActive: Boolean(row.isActive),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function saveOrganizationAiConfig(params: {
  organizationId: string;
  provider: AiProviderKey;
  apiKey: string;
  defaultModel: string;
  updatedBy: string;
}): Promise<OrganizationAiConfigDto> {
  const db = getDb();
  const { cipherText, iv } = await encryptApiKey(params.apiKey, requiredEncryptionSecret());
  const now = new Date().toISOString();

  const [existing] = await db
    .select()
    .from(organizationAiConfigs)
    .where(eq(organizationAiConfigs.organizationId, params.organizationId))
    .limit(1);

  const configId = existing ? existing.id : `ai_cfg_${crypto.randomUUID()}`;

  if (existing) {
    await db
      .update(organizationAiConfigs)
      .set({
        provider: params.provider,
        encryptedApiKey: cipherText,
        encryptedKeyIv: iv,
        defaultModel: params.defaultModel,
        isActive: true,
        updatedBy: params.updatedBy,
        updatedAt: now,
      })
      .where(eq(organizationAiConfigs.id, configId));
  } else {
    await db.insert(organizationAiConfigs).values({
      id: configId,
      organizationId: params.organizationId,
      provider: params.provider,
      encryptedApiKey: cipherText,
      encryptedKeyIv: iv,
      defaultModel: params.defaultModel,
      isActive: true,
      updatedBy: params.updatedBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    id: configId,
    organizationId: params.organizationId,
    provider: params.provider,
    maskedApiKey: maskApiKey(params.apiKey),
    defaultModel: params.defaultModel,
    isActive: true,
    updatedAt: now,
    updatedBy: params.updatedBy,
  };
}

export async function deleteOrganizationAiConfig(
  organizationId: string
): Promise<boolean> {
  const db = getDb();
  await db
    .delete(organizationAiConfigs)
    .where(eq(organizationAiConfigs.organizationId, organizationId));
  return true;
}

function requiredEncryptionSecret(): string {
  const secret = env.AI_KEYS_ENCRYPTION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("AI key encryption is unavailable until AI_KEYS_ENCRYPTION_SECRET is configured.");
  }
  return secret;
}
