/** Select an operator's private configuration without changing Wrangler's
 * default lookup when unset. Child processes inherit this exported variable. */
export function wranglerArgs(args: string[]): string[] {
  const config = process.env.EXTRAY_WRANGLER_CONFIG;
  return config ? ["--config", config, ...args] : args;
}
