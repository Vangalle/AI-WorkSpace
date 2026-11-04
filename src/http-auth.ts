import { timingSafeEqual } from 'node:crypto';
import type { UserId } from './rooms/types.js';
import { actor, invalid, object } from './validation.js';

export interface EngineServerOptions {
  token: string;
  userTokens?: Record<string, string>;
}

export interface HttpPrincipal { id: UserId; admin: boolean }

function bearer(token: unknown): Buffer {
  if (typeof token !== 'string' || token.length < 24 || token.length > 256 || /\s/.test(token)) invalid('HTTP token must be 24 to 256 non-whitespace characters');
  return Buffer.from(`Bearer ${token}`);
}

export function serverCredentials(options: EngineServerOptions) {
  const credentials = [{ authorization: bearer(options.token), principal: { id: 'user:local-user' as UserId, admin: true } }];
  const users = object(options.userTokens ?? {}, 'userTokens');
  if (Object.keys(users).length > 100) invalid('At most 100 user tokens may be configured');
  for (const [id, token] of Object.entries(users)) {
    const principal = actor(id);
    if (!principal.startsWith('user:') || principal === 'user:local-user') invalid('User tokens require a distinct user identity');
    const authorization = bearer(token);
    if (credentials.some((entry) => entry.authorization.equals(authorization))) invalid('HTTP tokens must be unique');
    credentials.push({ authorization, principal: { id: principal as UserId, admin: false } });
  }
  return {
    knownUsers: new Set(credentials.map((entry) => entry.principal.id)),
    authenticate(value: string | undefined): HttpPrincipal | undefined {
      const provided = Buffer.from(value ?? '');
      let principal: HttpPrincipal | undefined;
      for (const entry of credentials) {
        if (provided.length === entry.authorization.length && timingSafeEqual(provided, entry.authorization)) principal = entry.principal;
      }
      return principal;
    },
  };
}
