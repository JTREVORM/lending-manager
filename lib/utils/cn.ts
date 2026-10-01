import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose Tailwind class names, resolving conflicts in favour of the last one.
 *
 * `clsx` handles conditional and array inputs; `tailwind-merge` then removes
 * earlier classes that the later ones override, so a caller can pass
 * `className="px-6"` to a component whose base style is `px-4` and get `px-6`
 * instead of both.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
