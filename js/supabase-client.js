// LSR App - Cliente Supabase
// TODO: substituir pelas credenciais reais do seu projeto Supabase
// (mesmo padrão usado no Evvo / Treemali)

const SUPABASE_URL = 'https://udzwpfzzonrmpbaxmnlx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkendwZnp6b25ybXBiYXhtbmx4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwOTk1MDksImV4cCI6MjEwNTY3NTUwOX0.L43gP2XHAXPFjDwnUT_cXtMoRVhNK7acUIT5EyhyWoc';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});
