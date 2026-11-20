import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpStdioOAuthClient } from "@rakazo/contracts";
import { parseMcpStdioAuthorizationParams } from "@rakazo/contracts";
import { validateUrl } from "./mcp-transport.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { assertSafeRemoteUrl } from "./remote-mcp.js";

export type McpStdioAuthorization = {
  metadata: AuthorizationServerMetadata;
  codeVerifier: string;
};

export function mcpStdioClientInformation(
  client: McpStdioOAuthClient,
): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    issuer: new URL(client.authorizationServer).href,
  };
}

/** Follow the SDK's choice of authentication method. Basic requires form-encoded fields. */
export function stdioClientBasicAuthentication(
  client: OAuthClientInformationMixed,
  metadata?: AuthorizationServerMetadata,
): ((headers: Headers) => void) | undefined {
  if (
    !client.client_secret ||
    selectClientAuthMethod(client, metadata?.token_endpoint_auth_methods_supported ?? []) !==
      "client_secret_basic"
  )
    return undefined;
  const encode = (value: string) => new URLSearchParams([["", value]]).toString().slice(1);
  const basic = Buffer.from(`${encode(client.client_id)}:${encode(client.client_secret)}`).toString(
    "base64",
  );
  return (headers) => headers.set("Authorization", `Basic ${basic}`);
}

function validateIssuerMetadata(
  client: McpStdioOAuthClient,
  metadata: AuthorizationServerMetadata | undefined,
): AuthorizationServerMetadata {
  if (
    !metadata ||
    validateUrl(metadata.issuer).href !== validateUrl(client.authorizationServer).href
  ) {
    throw new Error("MCP OAuth metadata does not match the registered issuer");
  }
  // The token call uses the guarded fetch path and resolves again at dispatch.
  validateUrl(metadata.token_endpoint);
  validateUrl(metadata.authorization_endpoint);
  return metadata;
}

export async function beginMcpStdioAuthorization(input: {
  client: McpStdioOAuthClient;
  redirectUri: string;
  state: string;
  fetch: typeof fetch;
  resolveHostname?: RemoteTransportDependencies["resolveHostname"];
}): Promise<McpStdioAuthorization & { authorizationUrl: string }> {
  const metadata = validateIssuerMetadata(
    input.client,
    await discoverAuthorizationServerMetadata(input.client.authorizationServer, {
      fetchFn: input.fetch,
    }),
  );
  await Promise.all([
    assertSafeRemoteUrl(metadata.authorization_endpoint, input.resolveHostname),
    assertSafeRemoteUrl(metadata.token_endpoint, input.resolveHostname),
  ]);
  const start = await startAuthorization(input.client.authorizationServer, {
    metadata,
    clientInformation: mcpStdioClientInformation(input.client),
    redirectUrl: input.redirectUri,
    scope: input.client.scope,
    state: input.state,
  });
  const params = start.authorizationUrl.searchParams;
  const consent = params.getAll("prompt").includes("consent");
  if (consent) params.set("prompt", "consent");
  if (input.client.authorizationParams) {
    for (const [name, value] of parseMcpStdioAuthorizationParams(
      input.client.authorizationParams,
    )) {
      if (consent && name.toLowerCase() === "prompt") continue;
      params.set(name, value);
    }
  }
  return {
    metadata,
    codeVerifier: start.codeVerifier,
    authorizationUrl: start.authorizationUrl.href,
  };
}

/** The existing one-time session owns the verifier and validated endpoints. */
export async function exchangeMcpStdioAuthorization(
  input: McpStdioAuthorization & {
    client: McpStdioOAuthClient;
    code: string;
    redirectUri: string;
    fetch: typeof fetch;
  },
) {
  const clientInformation = mcpStdioClientInformation(input.client);
  const metadata = validateIssuerMetadata(input.client, input.metadata);
  const tokens = await exchangeAuthorization(input.client.authorizationServer, {
    metadata,
    clientInformation,
    authorizationCode: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    addClientAuthentication: stdioClientBasicAuthentication(clientInformation, metadata),
    fetchFn: input.fetch,
  });
  return { ...tokens, issuer: clientInformation.issuer };
}
