import { createClient } from '@supabase/supabase-js'

let client

export function getBrowserSupabase() {
  const url = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.')
  }

  client ??= createClient(url, anonKey)
  return client
}
