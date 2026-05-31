import { createOpenAI } from "@ai-sdk/openai";
import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";

export type AIProvider = "openai" | "azureopenai";
const MIN_JSON_SCHEMA_AZURE_API_VERSION = "2024-08-01-preview";

let tlsOverrideApplied = false;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function ensureMinAzureApiVersion(version: string): string {
  const dateMatch = version.match(/^(\d{4}-\d{2}-\d{2})/);
  const minDateMatch = MIN_JSON_SCHEMA_AZURE_API_VERSION.match(/^(\d{4}-\d{2}-\d{2})/);

  if (!dateMatch || !minDateMatch) {
    return MIN_JSON_SCHEMA_AZURE_API_VERSION;
  }

  return dateMatch[1] < minDateMatch[1]
    ? MIN_JSON_SCHEMA_AZURE_API_VERSION
    : version;
}

/**
 * Optional local/dev escape hatch for corporate gateways with self-signed cert chains.
 * Prefer installing the corporate CA (NODE_EXTRA_CA_CERTS) over disabling verification.
 */
function maybeAllowSelfSignedCerts(): void {
  if (!isTruthyEnv(process.env.WSO2_ALLOW_SELF_SIGNED_CERTS)) {
    return;
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  if (!tlsOverrideApplied) {
    tlsOverrideApplied = true;
    console.warn(
      "WSO2_ALLOW_SELF_SIGNED_CERTS is enabled. TLS certificate verification is disabled for this process."
    );
  }
}

/**
 * Returns the configured AI provider based on the AI_PROVIDER env var.
 * Supports "openai" (direct OpenAI) and "azureopenai" (Azure OpenAI via WSO2).
 */
function getProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER || "openai";
  if (provider !== "openai" && provider !== "azureopenai") {
    throw new Error(
      `Invalid AI_PROVIDER: "${provider}". Must be "openai" or "azureopenai".`
    );
  }
  return provider;
}

// In-memory token cache for WSO2 bearer tokens (refreshed before expiry)
interface WSO2TokenCache {
  accessToken: string;
  expiresAt: number;
}
let cachedToken: WSO2TokenCache | null = null;

/**
 * For WSO2-gated Azure OpenAI, fetch a bearer token using client credentials.
 * Caches the token in memory and reuses it until it is within 60 s of expiry.
 */
export async function getWSO2Token(): Promise<string> {
  maybeAllowSelfSignedCerts();

  // Return cached token if still valid (with 60 s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const tokenUrl = process.env.WSO2_TOKEN_URL;
  const consumerKey = process.env.WSO2_CONSUMER_KEY;
  const consumerSecret = process.env.WSO2_CONSUMER_SECRET;

  if (!tokenUrl || !consumerKey || !consumerSecret) {
    throw new Error(
      "WSO2_TOKEN_URL, WSO2_CONSUMER_KEY, and WSO2_CONSUMER_SECRET are required for Azure OpenAI via WSO2"
    );
  }

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`WSO2 token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

/**
 * Get a chat model instance based on the configured provider.
 * - openai: Uses OPENAI_API_KEY + OPENAI_MODEL
 * - azureopenai: Fetches WSO2 bearer token (cached) and passes it as both
 *   the api-key header and Authorization: Bearer header on every request.
 */
export async function getChatModel(): Promise<LanguageModel> {
  const provider = getProvider();

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");

    const openai = createOpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL || "gpt-4o";
    return openai(model);
  }

  // Azure OpenAI via WSO2 gateway
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;

  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT is required when AI_PROVIDER=azureopenai");

  // Fetch cached (or fresh) WSO2 bearer token
  const bearerToken = await getWSO2Token();

  // Build Azure config from the full WSO2 endpoint.
  // Example endpoint:
  // .../openai/deployments/<deployment>/chat/completions?api-version=2024-02-15-preview
  const url = new URL(endpoint);
  const configuredApiVersion =
    process.env.AZURE_OPENAI_API_VERSION ||
    url.searchParams.get("api-version") ||
    MIN_JSON_SCHEMA_AZURE_API_VERSION;
  const apiVersion = ensureMinAzureApiVersion(configuredApiVersion);

  const deploymentFromEndpoint =
    url.pathname.split("/openai/deployments/")[1]?.split("/")[0] || undefined;
  const resolvedDeployment = deploymentFromEndpoint || deployment;

  if (!resolvedDeployment) {
    throw new Error(
      "AZURE_OPENAI_CHAT_DEPLOYMENT is required when deployment is not present in AZURE_OPENAI_ENDPOINT"
    );
  }

  const gatewayPrefix = url.pathname.split("/openai/deployments")[0] || "";
  const baseURL = `${url.protocol}//${url.host}${gatewayPrefix}/openai`;

  const azure = createAzure({
    baseURL,
    apiKey: bearerToken,
    apiVersion,
    useDeploymentBasedUrls: true,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });

  return azure.chat(resolvedDeployment);
}

/**
 * Get the current AI provider name for display/logging.
 */
export function getProviderName(): string {
  const provider = getProvider();
  return provider === "openai" ? "OpenAI" : "Azure OpenAI (WSO2)";
}
