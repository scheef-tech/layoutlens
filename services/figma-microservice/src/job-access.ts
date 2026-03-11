import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

type ParsedJobReference = {
  jobId: string;
  usesSignature: boolean;
};

function getSigningSecret(): string | undefined {
  return getEnv("JOB_ACCESS_SECRET") || getEnv("CLERK_SECRET_KEY");
}

function computeSignature(jobId: string, secret: string): string {
  return createHmac("sha256", secret).update(jobId).digest("base64url");
}

export function createJobAccessToken(jobId: string): string {
  const secret = getSigningSecret();
  if (!secret) {
    return jobId;
  }
  return `${jobId}.${computeSignature(jobId, secret)}`;
}

export function verifyJobAccessToken(token: string): string | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator >= token.length - 1) {
    return null;
  }

  const jobId = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const secret = getSigningSecret();
  if (!secret) {
    return null;
  }

  const expected = computeSignature(jobId, secret);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer) ? jobId : null;
}

export function parseJobReference(reference: string): ParsedJobReference | null {
  const value = reference.trim();
  if (!value) {
    return null;
  }

  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator >= value.length - 1) {
    return {
      jobId: value,
      usesSignature: false
    };
  }

  const jobId = verifyJobAccessToken(value);
  if (!jobId) {
    return null;
  }
  return {
    jobId,
    usesSignature: true
  };
}
