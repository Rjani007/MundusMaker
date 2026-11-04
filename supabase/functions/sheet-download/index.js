// The publisher-sheet relay (relay.mjs), served by Supabase Edge Functions on
// Deno. Deploy: npx supabase functions deploy sheet-download
// --project-ref zrophtozeecslvsecndo (docs/website.md).
import { createHandler } from './relay.mjs';

Deno.serve(createHandler({ fetchImpl: fetch, supabaseUrl: Deno.env.get('SUPABASE_URL') }));
