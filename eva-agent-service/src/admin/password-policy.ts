import { argon2id, hash, verify } from "argon2";

import { adminBadRequest } from "./errors.js";

const COMPROMISED = new Set([
  "123456789012",
  "password1234",
  "qwerty123456",
  "administrator",
  "admin12345678",
  "letmein123456",
  "пароль1234567",
]);

export function assertPasswordPolicy(password: string, username = ""): void {
  if (password.length < 12) throw adminBadRequest("Пароль должен содержать не менее 12 символов");
  if (password.length > 256) throw adminBadRequest("Пароль слишком длинный");
  const normalized = password.toLowerCase();
  if (COMPROMISED.has(normalized) || (username.length >= 4 && normalized.includes(username.toLowerCase()))) {
    throw adminBadRequest("Этот пароль присутствует в списке скомпрометированных");
  }
}

export async function hashPassword(password: string): Promise<string> {
  return await hash(password, {
    type: argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
