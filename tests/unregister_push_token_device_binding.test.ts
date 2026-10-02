// unregister_push_token_device_binding.test.ts — M2 staged lockstep
// (Oct 1, 2026): unregisterPushTokenForLink must send this device's id as
// p_device_id so the server binds the delete to the device/link pair.
// Fails on the pre-M2 code (RPC args carried p_link_id only).
// Run: see tests/run.sh (node, no framework).
import { assert, summary } from './assert';
import { auth } from '../src/lib/auth';
import {
  __setNotificationsForTests,
  __setPlatformForTests,
  __setSupabaseForTests,
  unregisterPushTokenForLink,
} from '../src/lib/push';

declare const process: { exitCode?: number };

async function main(): Promise<void> {
  // Simulate a native device: platform not web, notifications module
  // present, Supabase client replaced by a recording mock.
  __setPlatformForTests('ios');
  __setNotificationsForTests({});
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  __setSupabaseForTests({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: { ok: true }, error: null };
    },
  });

  const deviceId = await auth.getDeviceId();
  await unregisterPushTokenForLink('link-abc-123');

  assert(rpcCalls.length === 1, 'one RPC call made');
  assert(
    rpcCalls[0].fn === 'unregister_push_token_for_link',
    'RPC targets unregister_push_token_for_link',
  );
  assert(rpcCalls[0].args.p_link_id === 'link-abc-123', 'p_link_id sent');
  assert(
    typeof rpcCalls[0].args.p_device_id === 'string' &&
      (rpcCalls[0].args.p_device_id as string).length > 0,
    'p_device_id sent as a non-empty string',
  );
  assert(
    rpcCalls[0].args.p_device_id === deviceId,
    'p_device_id is this device id (auth.getDeviceId())',
  );

  // Reset the seams so later suites see production behavior.
  __setNotificationsForTests(undefined);
  __setSupabaseForTests(undefined);
  __setPlatformForTests(null);

  summary('unregister_push_token_device_binding.test.ts');
}

void main();
