/**
 * Utilidad de composición de clases CSS: clsx evalúa condiciones y
 * twMerge resuelve conflictos entre utilidades Tailwind.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
