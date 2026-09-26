// Clear to Close — optional Supabase backend connection.
//
// The client is created lazily and only when both env vars are present.
// @supabase/supabase-js is require()d inside the function body (guarded by
// try/catch), so this module can be imported in a Node test environment
// where the package may not be installed yet.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

declare const process: { env: Record<string, string | undefined> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: any = undefined;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSupabase(): any | null {
  if (!isSupabaseConfigured()) return null;
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require('@supabase/supabase-js');
    cached = createClient(
      process.env.EXPO_PUBLIC_SUPABASE_URL!,
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    );
  } catch {
    cached = null;
  }
  return cached;
}
