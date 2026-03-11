type LogLevel = "INFO" | "WARN" | "ERROR";

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {}
): void {
  const cleanFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const prefix = `[${new Date().toISOString()}] [${level}] ${event}`;
  console.log(cleanFields ? `${prefix} ${cleanFields}` : prefix);
}
