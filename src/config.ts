import "dotenv/config";
import { resolve } from "node:path";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export interface AppConfig {
  port: number;
  databasePath: string;
  appUrl: string;
  cronSecret?: string;
  xaiApiKey?: string;
  xaiModel: string;
  xClientId?: string;
  xClientSecret?: string;
  xRedirectUri: string;
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  return {
    port,
    databasePath: resolve(process.env.DATABASE_PATH ?? "./data/threadline.sqlite"),
    appUrl: (process.env.APP_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    cronSecret: process.env.CRON_SECRET || undefined,
    xaiApiKey: process.env.XAI_API_KEY || undefined,
    xaiModel: process.env.XAI_MODEL ?? "grok-4.3",
    xClientId: process.env.X_CLIENT_ID || undefined,
    xClientSecret: process.env.X_CLIENT_SECRET || undefined,
    xRedirectUri: process.env.X_REDIRECT_URI ?? `http://localhost:${port}/auth/x/callback`,
  };
}

export function requireXOAuth(config: AppConfig): { clientId: string; clientSecret: string; redirectUri: string } {
  return {
    clientId: required(config.xClientId, "X_CLIENT_ID"),
    clientSecret: required(config.xClientSecret, "X_CLIENT_SECRET"),
    redirectUri: config.xRedirectUri,
  };
}
