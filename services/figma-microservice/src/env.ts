export function getEnv(key: string): string | undefined {
  const value = (Bun.env[key] || "").trim();
  return value.length > 0 ? value : undefined;
}

export function getEnvOr(key: string, fallback: string): string {
  return getEnv(key) || fallback;
}

export function getEnvInt(key: string, fallback: number): number {
  const raw = getEnv(key);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
