/** Tiny class-name joiner (keeps the ui package dependency-free). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
