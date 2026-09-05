export const PUBLIC_HASH_RE = /^[a-zA-Z0-9_-]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  if (value.length > 254 || !value.includes("@")) return false;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || local.length > 64 || !domain.includes(".")) return false;
  if (domain.length > 253 || /\.\./.test(domain)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function validatePassword(value: string): { ok: boolean; message?: string } {
  if (typeof value !== "string" || value.length < 8) {
    return { ok: false, message: "Password must be at least 8 characters." };
  }
  if (value.length > 256) {
    return { ok: false, message: "Password is too long." };
  }
  return { ok: true };
}

export function validateName(value: string): { ok: boolean; message?: string } {
  const name = value.trim();
  if (!name) return { ok: false, message: "Name is required." };
  if (name.length < 1 || name.length > 80) {
    return { ok: false, message: "Name must be between 1 and 80 characters." };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, message: "Name contains invalid characters." };
  }
  return { ok: true };
}

export function isSafeId(value: string): boolean {
  return typeof value === "string" && PUBLIC_HASH_RE.test(value) && value.length <= 80;
}

export function parsePagination(
  url: URL,
  defaults: { page: number; limit: number },
): { page: number; limit: number; offset: number } {
  const rawPage = Number(url.searchParams.get("page") ?? defaults.page);
  const rawLimit = Number(url.searchParams.get("limit") ?? defaults.limit);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, 10000) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 && rawLimit <= 100
      ? Math.floor(rawLimit)
      : defaults.limit;
  return { page, limit, offset: (page - 1) * limit };
}

export function parseSort<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value && (allowed as readonly string[]).includes(value)) return value as T;
  return fallback;
}
