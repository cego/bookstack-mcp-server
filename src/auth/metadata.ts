/** RFC 9728 section 3.1: metadata lives at the well-known prefix followed by the resource's path. */
export function protectedResourceMetadataPath(resource: string): string {
  const { pathname } = new URL(resource);
  return `/.well-known/oauth-protected-resource${pathname === '/' ? '' : pathname}`;
}

export function protectedResourceMetadataUrl(resource: string): string {
  return `${new URL(resource).origin}${protectedResourceMetadataPath(resource)}`;
}

/** The OAuth 2.0 Protected Resource Metadata document (RFC 9728) for this server. */
export function protectedResourceMetadata(resource: string, issuer: string) {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  };
}

/**
 * A Bearer challenge pointing clients at the metadata (RFC 6750 section 3, RFC 9728 section 5.1).
 * Without an error code when no token was sent, per RFC 6750 section 3.1.
 */
export function bearerChallenge(resource: string, error?: 'invalid_token'): string {
  const errorPart = error ? `error="${error}", ` : '';
  return `Bearer ${errorPart}resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}
