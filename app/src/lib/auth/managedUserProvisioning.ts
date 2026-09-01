import 'server-only';

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { UserRole } from '@/types';

const AUTH_RECONCILIATION_ATTEMPTS = 3;
const AUTH_RECONCILIATION_BACKOFF_MS = [50, 150] as const;

export interface ManagedPortalUser {
  id: string;
  email: string;
}

export type CreateManagedPortalUserResult =
  | { ok: true; user: ManagedPortalUser }
  | {
      ok: false;
      kind: 'misconfigured' | 'duplicate' | 'auth' | 'profile';
      error: unknown;
      cleanupError?: unknown;
    };

export function isPortalUserExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof value.code === 'string' ? value.code.toLowerCase() : '';
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  const status = typeof value.status === 'number' ? value.status : null;

  return code === 'user_exists'
    || message.includes('already')
    || message.includes('exists')
    || message.includes('registered')
    || status === 409;
}

function isPortalUserNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof value.code === 'string' ? value.code.toLowerCase() : '';
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  const status = typeof value.status === 'number' ? value.status : null;

  return code === 'user_not_found'
    || message.includes('not found')
    || status === 404;
}

type ReconciledAuthUser =
  | { found: true; userId: string }
  | { found: false; error?: unknown };

/**
 * `createUser` accepts a caller-provided UUID. That UUID is our attempt marker:
 * if the response is lost after Supabase commits the write, we can query the
 * exact id instead of searching by email or risking deletion of an older user.
 */
async function reconcileManagedAuthUser(input: {
  provisioningId: string;
  email: string;
}): Promise<ReconciledAuthUser> {
  if (!supabaseAdmin) {
    return { found: false, error: new Error('Supabase service role is not configured') };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < AUTH_RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, AUTH_RECONCILIATION_BACKOFF_MS[attempt - 1] ?? 150);
      });
    }
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(
        input.provisioningId,
      );
      if (error) {
        // A transport failure can be observed before GoTrue's write becomes
        // readable. Keep polling the exact caller-provided UUID; never fall
        // back to searching or deleting by email.
        if (!isPortalUserNotFoundError(error)) lastError = error;
        continue;
      }

      const user = data.user;
      if (!user) continue;
      const resolvedEmail = typeof user.email === 'string'
        ? user.email.trim().toLocaleLowerCase('en-US')
        : '';
      if (user.id !== input.provisioningId || resolvedEmail !== input.email) {
        return {
          found: false,
          error: new Error('Supabase Auth reconciliation returned an unexpected user'),
        };
      }
      return { found: true, userId: user.id };
    } catch (error) {
      lastError = error;
    }
  }

  return { found: false, ...(lastError ? { error: lastError } : {}) };
}

/**
 * Creates a confirmed Portal login and pins its profile to the requested role.
 *
 * Auth and profiles live in the same database, but Supabase exposes them as two
 * writes. If the second write fails, remove the just-created auth user so a
 * retry with the same email remains possible and no half-created login remains.
 */
export async function createManagedPortalUser(input: {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
}): Promise<CreateManagedPortalUserResult> {
  if (!supabaseAdmin) {
    return {
      ok: false,
      kind: 'misconfigured',
      error: new Error('Supabase service role is not configured'),
    };
  }

  const provisioningId = randomUUID();
  let createdUserId: string | undefined;
  let createError: unknown = null;
  try {
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      id: provisioningId,
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: {
        full_name: input.fullName,
        role: input.role,
      },
    });
    createError = error;
    createdUserId = created.user?.id;
  } catch (error) {
    createError = error;
  }

  if (createError) {
    if (isPortalUserExistsError(createError)) {
      return { ok: false, kind: 'duplicate', error: createError };
    }

    const reconciled = await reconcileManagedAuthUser({
      provisioningId,
      email: input.email,
    });
    if (reconciled.found) {
      createdUserId = reconciled.userId;
    } else {
      return {
        ok: false,
        kind: 'auth',
        error: createError,
        ...(reconciled.error ? { cleanupError: reconciled.error } : {}),
      };
    }
  }

  if (!createdUserId) {
    const missingIdError = new Error('Supabase Auth did not return the created user id');
    const reconciled = await reconcileManagedAuthUser({
      provisioningId,
      email: input.email,
    });
    if (!reconciled.found) {
      return {
        ok: false,
        kind: 'auth',
        error: missingIdError,
        ...(reconciled.error ? { cleanupError: reconciled.error } : {}),
      };
    }
    createdUserId = reconciled.userId;
  }

  const userId = createdUserId;

  let profileError: unknown = null;
  try {
    const result = await supabaseAdmin
      .from('profiles')
      .upsert(
        {
          id: userId,
          email: input.email,
          full_name: input.fullName,
          role: input.role,
        },
        { onConflict: 'id' },
      );
    profileError = result.error;
  } catch (error) {
    profileError = error;
  }

  if (profileError) {
    const cleanupError = await deleteManagedPortalUser(userId);
    return {
      ok: false,
      kind: 'profile',
      error: profileError,
      ...(cleanupError ? { cleanupError } : {}),
    };
  }

  return {
    ok: true,
    user: {
      id: userId,
      email: input.email,
    },
  };
}

export async function deleteManagedPortalUser(userId: string): Promise<unknown | null> {
  if (!supabaseAdmin) return new Error('Supabase service role is not configured');
  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    return error ?? null;
  } catch (error) {
    return error;
  }
}
