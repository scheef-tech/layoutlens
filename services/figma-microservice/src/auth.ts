import { verifyToken } from "@clerk/backend";
import { getEnv } from "./env";

export type AuthContext = {
  userId: string;
  role?: string;
};

function getAuthorizedParties(): string[] {
  const raw = getEnv("CLERK_AUTHORIZED_PARTIES");
  if (!raw) {
    return ["https://app.scheef.tech"];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }
  const [scheme, token] = authorizationHeader.trim().split(/\s+/, 2);
  if (!scheme || !token) {
    return undefined;
  }
  if (scheme.toLowerCase() !== "bearer") {
    return undefined;
  }
  return token;
}

export async function verifyAdminFromAuthorizationHeader(
  authorizationHeader: string | undefined
): Promise<AuthContext | null> {
  const token = readBearerToken(authorizationHeader);
  if (!token) {
    return null;
  }
  const secretKey = getEnv("CLERK_SECRET_KEY");
  if (!secretKey) {
    return null;
  }

  try {
    const payload = await verifyToken(token, {
      secretKey,
      authorizedParties: getAuthorizedParties()
    });
    if (!payload.sub) {
      return null;
    }

    const role = typeof payload.role === "string" ? payload.role : undefined;
    if (role !== "admin") {
      return null;
    }

    return {
      userId: payload.sub,
      role
    };
  } catch {
    return null;
  }
}
