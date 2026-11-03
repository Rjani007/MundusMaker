// Where the website finds its Supabase project (docs/website.md).
//
// The publishable key is meant to be public: it only names the project. What a
// signed-in GM may change is decided by the row level security policies in
// supabase/migrations, which the database enforces whatever this page does.

const hosted = {
  url: 'https://zrophtozeecslvsecndo.supabase.co',
  key: 'sb_publishable_bHPIbvmJamTlET8arHZNug_t5-i_kPK',
};

// The local stack from `npx supabase start` (the Supabase CLI's standard local key).
const local = {
  url: 'http://127.0.0.1:56421',
  key: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
};

const onThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const config = onThisComputer ? local : hosted;
