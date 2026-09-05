import { clsx, type ClassValue } from "clsx";

/** Tiny class-name joiner. Keeps the project dependency light. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
