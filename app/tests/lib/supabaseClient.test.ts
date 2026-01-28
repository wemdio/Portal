import { supabase } from '@/lib/supabaseClient';

describe('Supabase Client', () => {
  it('should export supabase client', () => {
    expect(supabase).toBeDefined();
  });

  it('should have auth methods', () => {
    expect(supabase.auth).toBeDefined();
    expect(typeof supabase.auth.getSession).toBe('function');
    expect(typeof supabase.auth.signInWithPassword).toBe('function');
    expect(typeof supabase.auth.signUp).toBe('function');
    expect(typeof supabase.auth.signOut).toBe('function');
  });

  it('should have from method for database queries', () => {
    expect(supabase.from).toBeDefined();
    expect(typeof supabase.from).toBe('function');
  });
});
