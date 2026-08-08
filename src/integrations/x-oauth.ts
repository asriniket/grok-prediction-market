import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../domain/errors.js";
import type { AccountHistoryInput, BotCredentials } from "../domain/types.js";
import type { AppConfig } from "../config.js";
import { requireXOAuth } from "../config.js";
import { XApiClient } from "./x-client.js";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const BOT_SCOPES = "tweet.read users.read tweet.write offline.access";
const TRADER_SCOPES = "tweet.read users.read";

type OAuthPurpose = "bot" | "trader";

interface PendingAuthorization {
  purpose: OAuthPurpose;
  verifier: string;
  expiresAt: number;
  returnTo: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
}

export class BotRegistry {
  private credentials: BotCredentials | null;

  constructor(initial?: BotCredentials) {
    this.credentials = initial ?? null;
  }

  set(credentials: BotCredentials): void {
    this.credentials = credentials;
  }

  get(): BotCredentials | null {
    return this.credentials;
  }
}

export class XOAuthService {
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(
    private readonly config: AppConfig,
    private readonly bots: BotRegistry,
    private readonly onCredentials: (credentials: BotCredentials) => void = () => undefined,
    private readonly onTrader: (history: AccountHistoryInput) => void = () => undefined,
  ) {}

  startBot(): string {
    return this.start("bot", "/");
  }

  startTrader(returnTo: string): string {
    return this.start("trader", returnTo);
  }

  private start(purpose: OAuthPurpose, returnTo: string): string {
    const { clientId, redirectUri } = requireXOAuth(this.config);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.pending.set(state, { purpose, verifier, expiresAt: Date.now() + 10 * 60 * 1000, returnTo });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: purpose === "bot" ? BOT_SCOPES : TRADER_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async complete(code: string, state: string): Promise<{ purpose: OAuthPurpose; username: string; userId: string; returnTo: string }> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw new AppError("OAuth state is invalid or expired", 400, "OAUTH_STATE_INVALID");
    const { clientId, clientSecret, redirectUri } = requireXOAuth(this.config);
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: pending.verifier,
      client_id: clientId,
    });
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new AppError(`X OAuth token exchange failed (${response.status}): ${detail.slice(0, 240)}`, 502, "OAUTH_EXCHANGE_FAILED");
    }
    const tokens = await response.json() as TokenResponse;
    if (!tokens.access_token) throw new AppError("X OAuth response did not contain an access token", 502, "OAUTH_EXCHANGE_FAILED");
    const xClient = new XApiClient(tokens.access_token);
    const user = await xClient.getCurrentUser();
    if (pending.purpose === "bot") {
      const credentials = { userId: user.id, accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
      this.bots.set(credentials);
      this.onCredentials(credentials);
    } else {
      this.onTrader(await xClient.getAccountHistory(user.id));
    }
    return { purpose: pending.purpose, username: user.username, userId: user.id, returnTo: pending.returnTo };
  }
}
