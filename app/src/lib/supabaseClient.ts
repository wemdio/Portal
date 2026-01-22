import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://whhkkmfcmstawodnghzw.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoaGtrbWZjbXN0YXdvZG5naHp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1MzgxMDgsImV4cCI6MjA4MjExNDEwOH0.JNeLI1tKHaWGWKXb7Wzdz3ldfFJrv1lZXKs36m8LZ7g';

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
