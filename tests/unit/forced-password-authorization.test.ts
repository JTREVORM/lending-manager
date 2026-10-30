import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('react', () => ({ cache: (fn: unknown) => fn }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ rpc }),
}));
import {
  getAuthContext,
  requireAuth,
  requirePermission,
  requireAnyPermission,
  contextCan,
} from '@/lib/auth/context';

describe('forced-password server authorization', () => {
  beforeEach(() => {
    rpc.mockResolvedValue({
      error: null,
      data: [
        {
          outcome: 'ok',
          auth_user_id: 'auth',
          profile_id: 'profile',
          full_name: 'Isolated',
          phone: '+256700000001',
          email: null,
          status: 'active',
          must_change_password: true,
          role_keys: ['owner_admin'],
        },
      ],
    });
  });

  it('retains recovery identity but publishes no business permissions', async () => {
    const result = await getAuthContext();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('missing recovery context');
    expect(result.context.roles).toEqual(['owner_admin']);
    expect(result.context.permissions).toEqual([]);
    expect(contextCan(result.context, 'loans:view')).toBe(false);
  });
  it('rejects replayed business actions even for the Owner/Admin role', async () => {
    await expect(requireAuth()).rejects.toThrow(/password change/i);
    await expect(requirePermission('loans:view')).rejects.toThrow(/password change/i);
    await expect(
      requireAnyPermission(['loans:view', 'users:reset_password']),
    ).rejects.toThrow(/password change/i);
  });
  it('preserves legitimate permissions after trusted confirmation', async () => {
    const result = await rpc();
    result.data[0].must_change_password = false;
    rpc.mockResolvedValue(result);
    expect((await requirePermission('loans:view')).roles).toContain('owner_admin');
  });
});
