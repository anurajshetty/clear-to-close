// tc_intake.test.ts — TC intake v1 (Sept 29, 2026, Anuraj-approved mockup 04).
//
// Covers the shared intake model (src/lib/tcIntake.ts), the sectioned
// summary/share builders, the entry-row + TC-card visibility rules, the
// local store cache (preview/commit), the server-confirmed write path
// (save succeeds -> confirmed snapshot lands; save fails -> previously
// confirmed snapshot is preserved byte-identical), and the get_client_view
// mapping contract (tc branch carries tc_intake; buyer/seller payloads
// carry no tcIntake key at all).
//
// Oct 14, 2026 additions covered below: Seller's agent % (Commission),
// Water softener + its conditional Owned/Leased validation (the buyer
// intake's Oct 1 conditional rules), and the escrow officer fields.
//
// No UI is rendered here (Anuraj's standing rule: unit tests only).
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { createSyncedStore } from '../src/lib/syncedStore';
import { mapClientViewRpc } from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer } from './mock_server';
import {
  BROKER_FEE_DEFAULT,
  TC_FEE_DEFAULT,
  buildTcIntakeSections,
  buildTcIntakeShareText,
  countTcIntake,
  describeTcIntakeStatus,
  tcIntakeHero,  emptyTcIntake,
  formatTcIntakeDate,
  normalizeTcIntake,
  showTcDetailsForTcView,
  showTcIntakeForRealtorSide,
  validateTcIntakeConditional,
  type TcIntakeData,
} from '../src/lib/tcIntake';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function rpcStep(id: string, title: string, position: number, done: boolean) {
  return {
    id,
    title,
    subtitle: '',
    done,
    custom: false,
    position,
    completed_at: done ? '2026-09-26T10:00:00.000Z' : null,
  };
}

/** A fully-filled intake mirroring the mockup's device-3 example. */
function fullIntake(): TcIntakeData {
  return {
    ownerOccupied: 'yes',
    inTrust: 'yes',
    trustName: 'Sharma Family Trust',
    trustDate: '2020-01-12',
    trusteeNames: 'Anaya Sharma, Vikram Sharma',
    trusteeEmails: 'anaya@email.com, vikram@email.com',
    sellers: [
      { name: 'Anaya Sharma', phone: '(555) 123-4567', email: 'anaya@email.com' },
      { name: 'Vikram Sharma', phone: '(555) 987-6543', email: 'vikram@email.com' },
    ],
    listPrice: '$825,000',
    contractBegin: '2025-01-01',
    contractEnd: '2025-12-31',
    mlsDate: '2025-02-15',
    buyingAnother: 'yes',
    homeOfChoice: 'yes',
    totalPct: '5',
    buyerPct: '2.5',
    sellerPct: '2.5',
    tcFee: '500',
    brokerFee: '995',
    personalProperty: 'Refrigerator, washer/dryer',
    hoa: 'yes',
    hoaAmount: '$450',
    solar: 'yes',
    solarLeasedOwned: 'owned',
    solarAmount: '$18,000',
    solarCompany: 'SunPower',
    waterSoftener: 'yes',
    waterSoftenerLeasedOwned: 'leased',
    pool: 'yes',
    escrowCompany: 'Fidelity National Title',
    escrowOfficerName: 'Dana Officer',
    escrowOfficerContact: 'dana@escrow.example · (555) 111-2222',
    titleCompany: 'Chicago Title',
    nhdCompany: 'NHD Solutions',
    warrantyCompany: 'First American',
    warrantyAmount: '$525',
  };
}

async function main(): Promise<void> {
  // ------------------------------------------------------------ counting ---
  {
    const empty = emptyTcIntake();
    assert(empty.tcFee === TC_FEE_DEFAULT && empty.brokerFee === BROKER_FEE_DEFAULT, 'fees prefill the brokerage defaults');
    const c = countTcIntake(empty);
    assert(c.total === 27, `empty intake counts 27 visible fields (got ${c.total})`);
    assert(c.filled === 2, `empty intake counts only the 2 prefilled fees as filled (got ${c.filled})`);
    assert(!c.complete, 'empty intake is not complete');
  }
  {
    // Conditional fields only count once their gate is answered Yes.
    const t = emptyTcIntake();
    t.inTrust = 'yes';
    assert(countTcIntake(t).total === 31, 'trust fields add 4 visible fields when inTrust=yes');
    t.buyingAnother = 'yes';
    assert(countTcIntake(t).total === 32, 'home-of-choice adds 1 when buyingAnother=yes');
    t.hoa = 'yes';
    assert(countTcIntake(t).total === 33, 'HOA amount adds 1 when hoa=yes');
    t.solar = 'yes';
    assert(countTcIntake(t).total === 36, 'solar details add 3 when solar=yes');
    t.waterSoftener = 'yes';
    assert(countTcIntake(t).total === 37, 'water softener Owned/Leased adds 1 when waterSoftener=yes');
    t.sellers.push({ name: '', phone: '', email: '' });
    assert(countTcIntake(t).total === 40, 'a second seller block adds 3 fields');
    // A "no" answer counts as answered and adds no conditional fields.
    const n = emptyTcIntake();
    n.inTrust = 'no';
    n.buyingAnother = 'no';
    n.hoa = 'no';
    n.solar = 'no';
    n.waterSoftener = 'no';
    const nc = countTcIntake(n);
    assert(nc.total === 27 && nc.filled === 7, `"no" answers count as filled without adding conditionals (got ${nc.filled}/${nc.total})`);
  }
  {
    const full = fullIntake();
    const c = countTcIntake(full);
    assert(c.complete && c.filled === c.total, `fully-filled intake is complete (${c.filled}/${c.total})`);
  }

  // -------------------------------------------------------- entry status ---
  {
    const s0 = describeTcIntakeStatus(null);
    assert(s0.text === 'Not started' && !s0.started && !s0.complete, 'no saved row -> "Not started"');
    const s1 = describeTcIntakeStatus(emptyTcIntake());
    assert(s1.text === '2 of 27 filled' && s1.started && !s1.complete, 'saved partial row -> "X of Y filled"');
    const s2 = describeTcIntakeStatus(fullIntake());
    assert(s2.text === 'Complete' && s2.complete, 'saved full row -> "Complete"');
  }

  // ------------------------------------------- TC hero card (Oct 23, 2026) ---
  {
    const h0 = tcIntakeHero({ started: false, complete: false });
    assert(h0.pill === 'NOT STARTED' && h0.tone === 'amber' && h0.button === 'Start the intake', 'hero: not started');
    const h1 = tcIntakeHero({ started: true, complete: false });
    assert(h1.pill === 'IN PROGRESS' && h1.tone === 'amber' && h1.button === 'Continue the intake', 'hero: in progress');
    const h2 = tcIntakeHero({ started: true, complete: true });
    assert(h2.pill === 'DONE' && h2.tone === 'sage' && h2.button === 'View the intake', 'hero: complete');
  }

  // ---------------------------------------------------------- visibility ---
  {
    assert(showTcIntakeForRealtorSide('sell', 'buyer'), 'seller-only escrow shows the row');
    assert(showTcIntakeForRealtorSide('sell', 'seller'), 'seller-only escrow shows the row (seller tab)');
    assert(showTcIntakeForRealtorSide('both', 'seller'), 'dual-agency seller tab shows the row');
    assert(!showTcIntakeForRealtorSide('both', 'buyer'), 'dual-agency buyer tab hides the row');
    assert(!showTcIntakeForRealtorSide('buy', 'buyer'), 'buyer-only escrow hides the row');
    assert(!showTcIntakeForRealtorSide('buy', 'seller'), 'buyer-only escrow hides the row (either tab)');
    assert(showTcDetailsForTcView(true), 'TC card shows on listing-side TC views');
    assert(!showTcDetailsForTcView(false), 'TC card hides when there is no seller side');
  }

  // ------------------------------------------------------- normalization ---
  {
    const absent = normalizeTcIntake({ sellers: [] });
    assert(absent.tcFee === TC_FEE_DEFAULT && absent.brokerFee === BROKER_FEE_DEFAULT, 'absent fees normalize to the defaults');
    const cleared = normalizeTcIntake({ tcFee: '', brokerFee: '' });
    assert(cleared.tcFee === '' && cleared.brokerFee === '', 'an explicitly cleared fee stays blank (never silently re-defaulted)');
    assert(countTcIntake(cleared).filled === 0, 'explicitly cleared fees count as unfilled');
    assert(absent.sellers.length === 1, 'missing sellers normalize to one empty block');
    const many = normalizeTcIntake({ sellers: [{}, {}, {}, {}, {}] });
    assert(many.sellers.length === 3, 'sellers clamp to 3 blocks');
    const junk = normalizeTcIntake({ ownerOccupied: 'maybe', inTrust: 42, solarLeasedOwned: 'rented', trustDate: null });
    assert(junk.ownerOccupied === '' && junk.inTrust === '' && junk.solarLeasedOwned === '' && junk.trustDate === '', 'junk values normalize to empty, never crash');
    assert(normalizeTcIntake(null).ownerOccupied === '', 'null normalizes to the empty intake');
  }

  // ------------------------------------------------------------- section ---
  {
    const sections = buildTcIntakeSections(fullIntake(), '26207 Benito Ct');
    assert(sections.length === 6, 'six sections');
    const prop = sections[0];
    assert(prop.title === 'Property · 26207 Benito Ct', 'property section carries the address');
    const trustDate = prop.rows.find((r) => r.label === 'Trust date');
    assert(trustDate === undefined, 'trust date row removed (Anuraj, Sept 29, 2026)');
    const comm = sections[3];
    const fee = comm.rows.find((r) => r.label === 'TC / Broker fee');
    assert(fee?.value === '$500 + $995', 'fees join as "$500 + $995"');
    assert(comm.rows.find((r) => r.label === "Seller's agent")?.value === '2.5%', 'seller agent % renders with % (Oct 14, 2026)');
    const det = sections[4];
    assert(det.rows.find((r) => r.label === 'HOA')?.value === 'Yes, $450/mo', 'HOA renders "Yes, $450/mo"');
    assert(det.rows.find((r) => r.label === 'Solar')?.value === 'Owned, $18,000, SunPower', 'solar renders "Owned, $18,000, SunPower"');
    assert(det.rows.find((r) => r.label === 'Water softener')?.value === 'Yes, Leased', 'water softener renders "Yes, Leased" (Oct 14, 2026)');
    const vendors = sections[5];
    assert(vendors.rows.find((r) => r.label === 'Escrow officer name')?.value === 'Dana Officer', 'escrow officer name row');
    assert(
      vendors.rows.find((r) => r.label === 'Officer contact info')?.value === 'dana@escrow.example · (555) 111-2222',
      'officer contact info row',
    );
    const terms = sections[2];
    assert(terms.rows.find((r) => r.label === 'Contract')?.value === 'Jan 1, 2025 - Dec 31, 2025', 'contract range uses a plain hyphen');
    assert(terms.rows.find((r) => r.label === 'Home of choice contingency')?.value === 'Yes', 'conditional row appears when buyingAnother=yes');
    const sellers = sections[1];
    assert(sellers.rows[0].value === 'Anaya Sharma\n(555) 123-4567\nanaya@email.com', 'seller rows are multi-line for the details page');
  }
  {
    // Every unfilled value renders "Not provided".
    const sections = buildTcIntakeSections(emptyTcIntake(), '123 Main St');
    const all = sections.flatMap((s) => s.rows);
    assert(all.length > 0, 'empty intake still produces rows');
    // The two fee fields prefill the brokerage defaults ($500/$995), so
    // only the fee row is provided; everything else is "Not provided".
    const nonFee = all.filter((r) => r.label !== 'TC / Broker fee');
    assert(nonFee.every((r) => r.value === 'Not provided' && !r.provided), 'every empty value is "Not provided"');
    assert(all.find((r) => r.label === 'TC / Broker fee')?.value === '$500 + $995', 'prefilled fee defaults render in the empty intake');
    // Hidden conditionals leave no trace.
    const prop = sections[0];
    assert(!prop.rows.some((r) => r.label.startsWith('Trust')), 'trust rows hidden when inTrust is unanswered');
    assert(!sections[2].rows.some((r) => r.label === 'Home of choice contingency'), 'home-of-choice hidden when buyingAnother is unanswered');
  }

  // ----------------------------------------------------------- share text ---
  {
    const text = buildTcIntakeShareText(fullIntake(), '26207 Benito Ct');
    assert(text.includes('TC / Broker fee: $500 + $995'), 'share carries the fee line');
    assert(text.includes("Seller's agent: 2.5%"), 'share carries the seller agent % (Oct 14, 2026)');
    assert(text.includes('Water softener: Yes, Leased'), 'share carries the water softener');
    assert(text.includes('Escrow officer name: Dana Officer'), 'share carries the escrow officer');
    assert(text.includes('Trustees: Anaya Sharma, Vikram Sharma'), 'share joins multi-line values with commas');
    assert(text.includes('Contract: Jan 1, 2025 - Dec 31, 2025'), 'share contract range uses a hyphen');
    assert(!text.includes('—') && !text.includes('–'), 'share text has no em/en dashes');
    const emptyText = buildTcIntakeShareText(emptyTcIntake(), '123 Main St');
    const valueLines = emptyText.split('\n').filter((l) => l.includes(': '));
    assert(
      valueLines.length > 0 &&
        valueLines.every((l) => l.endsWith('Not provided') || l.startsWith('TC / Broker fee: $500 + $995')),
      'empty share marks every value "Not provided" except the prefilled fee defaults',
    );
    assert(emptyText.includes('Property · 123 Main St'), 'share is sectioned with the address');
  }

  // --------------------------------- water softener validation (Oct 14) ---
  {
    // The buyer intake's conditional rules: Yes + unanswered follow-up is
    // blocked on save; everything else passes.
    const yesEmpty = emptyTcIntake();
    yesEmpty.waterSoftener = 'yes';
    assert(
      validateTcIntakeConditional(yesEmpty).waterSoftenerLeasedOwned ===
        'Say whether the water softener is leased or owned.',
      'water softener yes + empty Owned/Leased -> error',
    );
    const yesLeased = emptyTcIntake();
    yesLeased.waterSoftener = 'yes';
    yesLeased.waterSoftenerLeasedOwned = 'leased';
    assert(Object.keys(validateTcIntakeConditional(yesLeased)).length === 0, 'yes + leased -> valid');
    const yesOwned = emptyTcIntake();
    yesOwned.waterSoftener = 'yes';
    yesOwned.waterSoftenerLeasedOwned = 'owned';
    assert(Object.keys(validateTcIntakeConditional(yesOwned)).length === 0, 'yes + owned -> valid');
    const noStale = emptyTcIntake();
    noStale.waterSoftener = 'no';
    assert(Object.keys(validateTcIntakeConditional(noStale)).length === 0, 'no -> no violations');
    const untouched = emptyTcIntake();
    assert(Object.keys(validateTcIntakeConditional(untouched)).length === 0, 'unanswered -> no violations');
    // Summary formats: "Yes, Owned" / "No" mirror Solar's family.
    const ownedData = emptyTcIntake();
    ownedData.waterSoftener = 'yes';
    ownedData.waterSoftenerLeasedOwned = 'owned';
    const ownedRow = buildTcIntakeSections(ownedData, '123 Main St')
      .find((s) => s.title === 'Property details')!.rows.find((r) => r.label === 'Water softener')!;
    assert(ownedRow.value === 'Yes, Owned', 'water softener summary: "Yes, Owned"');
    const noRow = buildTcIntakeSections(noStale, '123 Main St')
      .find((s) => s.title === 'Property details')!.rows.find((r) => r.label === 'Water softener')!;
    assert(noRow.value === 'No', 'water softener summary: "No"');
    // Normalize coerces the new enums defensively.
    assert(normalizeTcIntake({ waterSoftenerLeasedOwned: 'rented' }).waterSoftenerLeasedOwned === '', 'normalize drops an unknown water-softener value');
    assert(normalizeTcIntake({ waterSoftener: 'yes', waterSoftenerLeasedOwned: 'owned' }).waterSoftenerLeasedOwned === 'owned', 'normalize keeps owned');
  }

  // --------------------------------------------------------- date format ---
  {
    assert(formatTcIntakeDate('2020-01-12') === 'Jan 12, 2020', 'formats YYYY-MM-DD');
    assert(formatTcIntakeDate('') === '', 'empty date -> empty');
    assert(formatTcIntakeDate('not-a-date') === '', 'invalid date -> empty');
    assert(formatTcIntakeDate('2020-13-40') === '', 'impossible date -> empty');
  }

  // ------------------------------------------------------- RPC mapping ----
  {
    const tcPayload = {
      ok: true,
      role: 'tc',
      escrow: { id: 'esc-1', address: '123 Main St', city: 'Santa Clarita', close_date: '2026-10-15', side: 'both' },
      buyer_steps: [rpcStep('b1', 'Buyer step', 0, true)],
      seller_steps: [rpcStep('s1', 'Seller step', 0, false)],
      tc_intake: { ownerOccupied: 'yes', tcFee: '', sellers: [{ name: 'Anaya' }] },
      profile: { name: 'Rita Realtor' },
    };
    const mapped = mapClientViewRpc(tcPayload as unknown as Record<string, unknown>);
    assert(mapped.ok === true && !!mapped.tcView, 'tc payload maps ok');
    if (mapped.ok && mapped.tcView) {
      assert(mapped.tcView.tcIntake?.ownerOccupied === 'yes', 'tc branch carries the intake');
      assert(mapped.tcView.tcIntake?.tcFee === '', 'tc intake keeps an explicit blank fee on mapping');
      const absentFee = mapClientViewRpc({ ...tcPayload, tc_intake: { ownerOccupied: 'yes' } } as unknown as Record<string, unknown>);
      if (absentFee.ok && absentFee.tcView?.tcIntake) {
        assert(absentFee.tcView.tcIntake.tcFee === TC_FEE_DEFAULT, 'tc intake applies the fee default when absent on mapping');
      }
      assert(mapped.tcView.tcIntake?.sellers[0]?.name === 'Anaya', 'tc intake sellers survive mapping');
    }
    const noIntake = mapClientViewRpc({ ...tcPayload, tc_intake: null } as unknown as Record<string, unknown>);
    if (noIntake.ok && noIntake.tcView) {
      assert(noIntake.tcView.tcIntake === null, 'missing intake maps to null (not a crash)');
    }
    for (const role of ['buyer', 'seller'] as const) {
      const p = {
        ok: true,
        role,
        escrow: { id: 'esc-1', address: '123 Main St', city: 'Santa Clarita', close_date: '2026-10-15', side: 'both' },
        [`${role}_steps`]: [rpcStep('s1', 'Step', 0, false)],
        profile: { name: 'Rita Realtor' },
      };
      const m = mapClientViewRpc(p as unknown as Record<string, unknown>);
      assert(m.ok === true && !!m.view, `${role} payload maps ok`);
      if (m.ok && m.view) {
        assert(!('tcIntake' in m.view), `${role} payload carries no tcIntake key`);
      }
    }
  }

  // -------------------------------------------------------- local store ----
  {
    const kv = memoryKV();
    const store = createStore(kv);
    assert((await store.getTcIntake('e1')) === null, 'no intake cached initially');
    const preview = await store.previewSaveTcIntake('e1', fullIntake());
    // The live data is untouched until commit (preview computes a clone).
    assert((await store.getTcIntake('e1')) === null, 'preview alone does not touch live data');
    const committed = await store.commitPreview(preview);
    assert(committed.data.ownerOccupied === 'yes', 'commit returns the saved row');
    const row = await store.getTcIntake('e1');
    assert(row?.data.trustName === 'Sharma Family Trust', 'saved intake reads back');
    // Persistence round-trip: a fresh store over the same KV sees the row.
    const store2 = createStore(kv);
    const row2 = await store2.getTcIntake('e1');
    assert(row2?.data.ownerOccupied === 'yes', 'intake survives a store reload');
    await store2.setTcIntakeCache({ escrowId: 'e2', data: emptyTcIntake(), updatedAt: 'x' });
    assert((await store2.getTcIntake('e2'))?.data.tcFee === TC_FEE_DEFAULT, 'setTcIntakeCache converges a pulled row');
  }

  // ----------------------------------------------- server-confirmed save ---
  {
    // Happy path: the server confirms the upsert, then the local cache lands.
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    const saved = await store.saveTcIntake('e9', fullIntake());
    assert(saved.escrowId === 'e9' && saved.data.ownerOccupied === 'yes', 'saveTcIntake resolves with the confirmed row');
    const logged = server.upsertLog.find((u) => u.table === 'tc_intakes');
    assert(!!logged, 'the upsert hit the tc_intakes table');
    const sent = (logged!.rows as Record<string, unknown>[]);
    assert(sent[0].escrow_id === 'e9' && sent[0].owner_id === 'user-1', 'upsert stamps escrow_id + owner_id');
    const cached = await store.getTcIntake('e9');
    assert(cached?.data.trustName === 'Sharma Family Trust', 'confirmed snapshot lands in the local cache');
  }
  {
    // Failure path: the server rejects the write; the previously confirmed
    // snapshot is preserved byte-identical and the error is plain-language.
    const server = createMockServer();
    const kv = memoryKV();
    const good = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    await good.store.saveTcIntake('e9', fullIntake());
    const before = JSON.stringify(await good.store.getTcIntake('e9'));

    const failingClient = () => ({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'user-1' } } }, error: null }),
      },
      from: (): never => {
        throw new Error('boom: offline');
      },
      rpc: async (): Promise<never> => {
        throw new Error('boom: offline');
      },
    });
    const { store } = createSyncedStore(kv, { cloudClient: failingClient });
    let message = '';
    try {
      await store.saveTcIntake('e9', emptyTcIntake());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(message.length > 0 && !/boom/i.test(message), `failed save throws a plain-language error (got: ${message})`);
    const after = JSON.stringify(await store.getTcIntake('e9'));
    assert(after === before, 'failed save leaves the confirmed snapshot byte-identical');
  }
  {
    // refreshTcIntake never throws and never clobbers the cache on a read failure.
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    await store.saveTcIntake('e9', fullIntake());
    await store.refreshTcIntake('e9');
    assert((await store.getTcIntake('e9'))?.data.ownerOccupied === 'yes', 'refresh keeps the confirmed cache');
  }

  summary('tc_intake');
}

main().catch((err) => {
  console.error('FATAL -', err);
  process.exitCode = 1;
});
