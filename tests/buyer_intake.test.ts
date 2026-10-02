// buyer_intake.test.ts — Buyer intake v1 (Oct 1, 2026, Anuraj-approved mockup 08).
//
// Covers the shared intake model (src/lib/buyerIntake.ts), the auto-fill
// seed, the sectioned summary/share builders, the entry-row + TC-card
// visibility rules, the math warning, the local store cache
// (preview/commit), the server-confirmed write path (save succeeds ->
// confirmed snapshot lands; save fails -> previously confirmed snapshot is
// preserved byte-identical), and the get_client_view mapping contract (tc
// branch carries buyer_intake; buyer/seller payloads carry no buyerIntake
// key at all).
//
// No UI is rendered here (Anuraj's standing rule: unit tests only). The
// DateField clear-control wiring and the entry-row/TC-card gating are
// guarded by static structural assertions (the repo's established
// CTC_REPO_ROOT pattern), since they are pure prop wiring in route files.
import { assert, summary } from './assert';
import { memoryKV } from '../src/lib/kv';
import { createStore } from '../src/lib/store';
import { createSyncedStore } from '../src/lib/syncedStore';
import { mapClientViewRpc } from '../src/lib/cloudSync';
import { createMockServer, mockCloudFromServer } from './mock_server';
import {
  BUYER_INTAKE_MAX_BUYERS,
  autoFillBuyerIntake,
  buildBuyerIntakeSections,
  buildBuyerIntakeShareText,
  checkBuyerIntakeMath,
  countBuyerIntake,
  describeBuyerIntakeStatus,
  emptyBuyerIntake,
  normalizeBuyerIntake,
  showBuyerDetailsForTcView,
  showBuyerIntakeForRealtorSide,
  type BuyerIntakeData,
  validateBuyerIntakeConditional,
} from '../src/lib/buyerIntake';
import { emptyTcIntake } from '../src/lib/tcIntake';

declare const process: { env: Record<string, string | undefined>; exitCode?: number };
declare const require: (id: string) => { readFileSync: (...args: unknown[]) => string; join: (...args: string[]) => string };

process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

function repoFile(rel: string): string {
  const fs = require('fs');
  const path = require('path');
  const root = (process.env['CTC_REPO_ROOT'] as string) ?? '';
  return fs.readFileSync(path.join(root, rel), 'utf8') as string;
}

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
function fullIntake(): BuyerIntakeData {
  return {
    agentName: 'Rita Realtor',
    agentEmail: 'rita@realty.com',
    buyers: [
      { name: 'Anaya Sharma', phone: '(555) 123-4567', email: 'anaya@email.com' },
      { name: 'Vikram Sharma', phone: '(555) 765-4321', email: 'vikram@email.com' },
    ],
    offerAddress: '123 Main St',
    purchasePrice: '975000',
    deposit: '25000',
    downPayment: '195000',
    loanAmount: '780000',
    closeOfEscrow: '2026-10-15',
    possession: '2026-10-16',
    saleOfBuyersProperty: 'no',
    investigation: 'yes',
    investigationDays: '17',
    appraisal: 'yes',
    appraisalDays: '21',
    loan: 'yes',
    loanDays: '21',
    personalProperty: 'Refrigerator, washer, dryer included.',
    hoa: 'yes',
    hoaAmount: '250',
    solar: 'yes',
    solarLeasedOwned: 'owned',
    solarAmount: '18000',
    pool: 'no',
    warrantyCompany: 'Fidelity National Home Warranty',
    warrantyTerms: '1 year, $75 trade fee',
    warrantyAmount: '650',
  };
}

async function main(): Promise<void> {
  // ------------------------------------------------------------- normalize --
  {
    const n = normalizeBuyerIntake(undefined);
    assert(n.agentName === '' && n.buyers.length === 1 && n.investigation === '', 'normalize(undefined) -> empty intake with one buyer block');
    const corrupt = normalizeBuyerIntake({ agentName: 42, buyers: 'nope', investigation: 'maybe', solarLeasedOwned: 'rented' });
    assert(
      corrupt.agentName === '' && corrupt.buyers.length === 1 && corrupt.investigation === '' && corrupt.solarLeasedOwned === '',
      'corrupt JSON coerces to empty (renders "Not provided", never crashes)',
    );
    const capped = normalizeBuyerIntake({ buyers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] });
    assert(capped.buyers.length === BUYER_INTAKE_MAX_BUYERS, 'normalize caps buyers at 3');
    assert(BUYER_INTAKE_MAX_BUYERS === 3, 'buyer block cap is 3');
  }

  // ----------------------------------------------------------------- count --
  {
    // The mockup's "5 of 23 filled": with 1 buyer block and no Yes answers,
    // exactly 23 visible fields; the auto-filled draft fills 5.
    const auto = autoFillBuyerIntake(
      { name: 'Rita Realtor', email: 'rita@realty.com' },
      { buyerName: '', address: '123 Main St', closeDate: '2026-10-15' },
      [{ partyName: 'Anaya Sharma' }],
    );
    const c = countBuyerIntake(auto.data);
    assert(c.total === 23, `one buyer block + no Yes answers -> 23 visible fields (got ${c.total})`);
    assert(c.filled === 5, `auto-filled draft fills 5 (got ${c.filled})`);
    assert(!c.complete, 'draft is not complete');

    // Hidden conditional fields never count: a "No" investigation must not
    // count its days field.
    const noYes = emptyBuyerIntake();
    noYes.investigation = 'no';
    noYes.investigationDays = '17';
    const c2 = countBuyerIntake(noYes);
    assert(c2.total === 23, 'hidden contingency-days fields do not count toward the total');
    assert(c2.filled === 1, 'only the answered Yes/No counts when the days field is hidden');

    // A Yes answer reveals the days field and it counts.
    const yes = emptyBuyerIntake();
    yes.investigation = 'yes';
    const c3 = countBuyerIntake(yes);
    assert(c3.total === 24, 'a Yes answer adds its days field to the total');
    assert(c3.filled === 1, 'unfilled revealed days field is not counted as filled');

    // Hidden buyer blocks never count.
    const twoBuyers = emptyBuyerIntake();
    twoBuyers.buyers.push({ name: '', phone: '', email: '' });
    assert(countBuyerIntake(twoBuyers).total === 26, 'each visible buyer block adds 3 fields');

    // Full intake: 2 buyers + all Yes answers.
    const full = countBuyerIntake(fullIntake());
    assert(full.total === 32 && full.filled === 32 && full.complete, 'fully filled intake is complete');
  }

  // ------------------------------------------------------------ auto-fill ---
  {
    // Buyer 1 name precedence: escrow.buyerName first, else the first
    // non-revoked buyer invite's partyName (filtering is the caller's job).
    const fromEscrow = autoFillBuyerIntake(
      null,
      { buyerName: 'Escrow Buyer', address: '', closeDate: '' },
      [{ partyName: 'Invite Buyer' }],
    );
    assert(fromEscrow.data.buyers[0].name === 'Escrow Buyer', 'buyer 1 name prefers escrow.buyerName');
    const fromInvite = autoFillBuyerIntake(
      null,
      { buyerName: '', address: '', closeDate: '' },
      [{ partyName: 'Invite Buyer' }],
    );
    assert(fromInvite.data.buyers[0].name === 'Invite Buyer', 'buyer 1 name falls back to the buyer invite party name');
    const none = autoFillBuyerIntake(null, { buyerName: '', address: '', closeDate: '' }, []);
    assert(none.data.buyers[0].name === '', 'no buyer name source -> blank, nothing assumed');

    // Agent fields seed from the profile.
    const p = autoFillBuyerIntake({ name: 'Rita Realtor', email: 'rita@realty.com' }, { buyerName: '', address: '123 Main St', closeDate: '2026-10-15' }, []);
    assert(p.data.agentName === 'Rita Realtor' && p.data.agentEmail === 'rita@realty.com', 'agent name/email seed from the profile');
    assert(p.seed.agentName === 'Rita Realtor' && p.seed.offerAddress === '123 Main St' && p.seed.closeOfEscrow === '2026-10-15', 'seed carries the seeded values for the pill');
    assert(p.seed.buyer1Name === undefined, 'unseeded fields have no seed entry');

    // Everything stays editable: the seed is a starting value, not a lock.
    const editable = p.data;
    assert(editable.offerAddress === '123 Main St', 'offer address is editable (seeded, not locked)');
  }

  // ---------------------------------------------------------- math check ---
  {
    // Deposit counts in the purchase-price check (Anuraj, Oct 1, 2026):
    // price = deposit + down payment + loan. Empty deposit counts as 0.
    const live = { ...emptyBuyerIntake(), purchasePrice: '983000', deposit: '25000', downPayment: '200000', loanAmount: '758000' };
    assert(checkBuyerIntakeMath(live) === null, 'Anuraj live numbers: 25000 + 200000 + 758000 = 983000 -> no warning');
    const full = { ...fullIntake(), purchasePrice: '1000000' };
    assert(checkBuyerIntakeMath(full) === null, '25000 + 195000 + 780000 = 1000000 -> no warning');
    const emptyDeposit = { ...emptyBuyerIntake(), purchasePrice: '975000', deposit: '', downPayment: '195000', loanAmount: '780000' };
    assert(checkBuyerIntakeMath(emptyDeposit) === null, 'empty deposit counts as 0: 195000 + 780000 = 975000 -> no warning');
    const missingDeposit = { ...emptyBuyerIntake(), purchasePrice: '983000', deposit: '', downPayment: '200000', loanAmount: '758000' };
    const note = checkBuyerIntakeMath(missingDeposit);
    assert(typeof note === 'string' && note.length > 0, 'deposit left empty when it should count -> warns');
    assert(
      note === 'Purchase price does not match the deposit, down payment, and loan amount. Worth a second look.',
      'warning uses the exact approved copy',
    );
    assert(!/block|save/i.test(note ?? ''), 'the note is gentle, never mentions blocking');
    const partial = { ...emptyBuyerIntake(), purchasePrice: '975000', downPayment: '195000' };
    assert(checkBuyerIntakeMath(partial) === null, 'warning fires only when price/down/loan are filled');
  }

  // ------------------------------------------------------- status / sides --
  {
    assert(describeBuyerIntakeStatus(null).text === 'Not started', 'null -> Not started');
    assert(describeBuyerIntakeStatus(emptyBuyerIntake()).text === '0 of 23 filled', 'empty draft -> 0 of 23 filled');
    const s = describeBuyerIntakeStatus(fullIntake());
    assert(s.text === 'Complete' && s.complete, 'full intake -> Complete');

    // Realtor entry-row gating: buyer-side escrows only.
    assert(showBuyerIntakeForRealtorSide('buy', 'buyer') === true, 'buy side always shows');
    assert(showBuyerIntakeForRealtorSide('both', 'buyer') === true, 'dual agency shows on the buyer tab');
    assert(showBuyerIntakeForRealtorSide('both', 'seller') === false, 'dual agency hides on the seller tab');
    assert(showBuyerIntakeForRealtorSide('sell', 'buyer') === false, 'sell side never shows');

    // TC card gating: buyer-side escrows only.
    assert(showBuyerDetailsForTcView(true) === true, 'TC card shows on buyer-side escrows');
    assert(showBuyerDetailsForTcView(false) === false, 'TC card hides on seller-only TC views');
  }

  // -------------------------------------------------------------- sections --
  {
    const sections = buildBuyerIntakeSections(fullIntake(), '123 Main St');
    const titles = sections.map((s) => s.title);
    assert(
      JSON.stringify(titles) === JSON.stringify(['Agent', 'Buyers', 'Offer terms', 'Dates', 'Contingencies', 'Property details']),
      'six sections in mockup order',
    );
    const buyers = sections.find((s) => s.title === 'Buyers')!;
    assert(buyers.rows.length === 2 && buyers.rows[0].value.includes('Anaya Sharma'), 'buyer rows join name/phone/email');
    const contingencies = sections.find((s) => s.title === 'Contingencies')!;
    const inv = contingencies.rows.find((r) => r.label === 'Investigation')!;
    assert(inv.value === 'Yes, 17 days', 'Yes contingency shows its days');
    const details = sections.find((s) => s.title === 'Property details')!;
    const warranty = details.rows.find((r) => r.label === 'Warranty')!;
    assert(warranty.value.split('\n').length === 3, 'warranty rows combine company/terms/amount');
    const solar = details.rows.find((r) => r.label === 'Solar')!;
    assert(solar.value.includes('Owned') && solar.value.includes('$18000'), 'solar shows leased/owned + amount');

    // Unfilled values render "Not provided" with the muted treatment.
    const emptySections = buildBuyerIntakeSections(emptyBuyerIntake(), '123 Main St');
    const agent = emptySections.find((s) => s.title === 'Agent')!;
    assert(agent.rows[0].value === 'Not provided' && !agent.rows[0].provided, 'empty values render "Not provided"');
  }

  // ------------------------------------------------------------ share text --
  {
    const text = buildBuyerIntakeShareText(fullIntake(), '123 Main St');
    assert(text.startsWith('Buyer intake · 123 Main St'), 'share text is headed by the escrow');
    assert(text.includes('Offer terms') && text.includes('Contingencies'), 'share text carries all sections');
    assert(!/\n{3,}/.test(text), 'no runaway blank lines');
    const emptyText = buildBuyerIntakeShareText(emptyBuyerIntake(), '123 Main St');
    assert(emptyText.includes('Not provided'), 'unfilled values share as "Not provided"');
  }

  // ---------------------------------------------------------- store cache ---
  {
    // preview/commit: the live cache is untouched until commitPreview.
    const kv = memoryKV();
    const local = createStore(kv);
    assert((await local.getBuyerIntake('e1')) === null, 'getBuyerIntake returns null before anything is saved');
    const p = await local.previewSaveBuyerIntake('e1', fullIntake());
    assert((await local.getBuyerIntake('e1')) === null, 'preview leaves the live cache untouched');
    await local.commitPreview(p);
    const row = await local.getBuyerIntake('e1');
    assert(row?.data.agentName === 'Rita Realtor', 'commitPreview lands the row');
    assert(row?.escrowId === 'e1', 'row carries the escrow id');

    // Persisted rows are defensively normalized on load.
    const store2 = createStore(kv);
    const row2 = await store2.getBuyerIntake('e1');
    assert(row2?.data.buyers[0].name === 'Anaya Sharma', 'intake survives a store reload');
    await store2.setBuyerIntakeCache({ escrowId: 'e2', data: emptyBuyerIntake(), updatedAt: 'x' });
    assert((await store2.getBuyerIntake('e2'))?.data.agentName === '', 'setBuyerIntakeCache converges a pulled row');

    // A TC intake save must not drop buyer intake rows (shared snapshot).
    await store2.saveTcIntake('e1', emptyTcIntake());
    assert((await store2.getBuyerIntake('e1'))?.data.agentName === 'Rita Realtor', 'a TC intake save preserves buyer intake rows');
  }

  // ----------------------------------------------- server-confirmed save ---
  {
    // Happy path: the server confirms the upsert, then the local cache lands.
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    const saved = await store.saveBuyerIntake('e9', fullIntake());
    assert(saved.escrowId === 'e9' && saved.data.agentName === 'Rita Realtor', 'saveBuyerIntake resolves with the confirmed row');
    const logged = server.upsertLog.find((u) => u.table === 'buyer_intakes');
    assert(!!logged, 'the upsert hit the buyer_intakes table');
    const sent = (logged!.rows as Record<string, unknown>[]);
    assert(sent[0].escrow_id === 'e9' && sent[0].owner_id === 'user-1', 'upsert stamps escrow_id + owner_id');
    const cached = await store.getBuyerIntake('e9');
    assert(cached?.data.buyers[0].name === 'Anaya Sharma', 'confirmed snapshot lands in the local cache');
  }
  {
    // Failure path: the server rejects the write; the previously confirmed
    // snapshot is preserved byte-identical and the error is plain-language.
    const server = createMockServer();
    const kv = memoryKV();
    const good = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    await good.store.saveBuyerIntake('e9', fullIntake());
    const before = JSON.stringify(await good.store.getBuyerIntake('e9'));

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
      await store.saveBuyerIntake('e9', emptyBuyerIntake());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(message.length > 0 && !/boom/i.test(message), `failed save throws a plain-language error (got: ${message})`);
    const after = JSON.stringify(await store.getBuyerIntake('e9'));
    assert(after === before, 'failed save leaves the confirmed snapshot byte-identical');
  }
  {
    // refreshBuyerIntake never throws and never clobbers the cache on a read failure.
    const server = createMockServer();
    const kv = memoryKV();
    const { store } = createSyncedStore(kv, { cloudClient: mockCloudFromServer(server) });
    await store.saveBuyerIntake('e9', fullIntake());
    await store.refreshBuyerIntake('e9');
    assert((await store.getBuyerIntake('e9'))?.data.agentName === 'Rita Realtor', 'refresh keeps the confirmed cache');
  }

  // ------------------------------------------------------- RPC mapping ----
  {
    const tcPayload = {
      ok: true,
      role: 'tc',
      escrow: { id: 'esc-1', address: '123 Main St', city: 'Santa Clarita', close_date: '2026-10-15', side: 'both' },
      buyer_steps: [rpcStep('b1', 'Buyer step', 0, true)],
      seller_steps: [rpcStep('s1', 'Seller step', 0, false)],
      buyer_intake: { agentName: 'Rita Realtor', buyers: [{ name: 'Anaya' }] },
      profile: { name: 'Rita Realtor' },
    };
    const mapped = mapClientViewRpc(tcPayload as unknown as Record<string, unknown>);
    assert(mapped.ok === true && !!mapped.tcView, 'tc payload maps ok');
    if (mapped.ok && mapped.tcView) {
      assert(mapped.tcView.buyerIntake?.agentName === 'Rita Realtor', 'tc branch carries the buyer intake');
      assert(mapped.tcView.buyerIntake?.buyers[0]?.name === 'Anaya', 'tc intake buyers survive mapping');
    }
    const noIntake = mapClientViewRpc({ ...tcPayload, buyer_intake: null } as unknown as Record<string, unknown>);
    if (noIntake.ok && noIntake.tcView) {
      assert(noIntake.tcView.buyerIntake === null, 'missing intake maps to null (not a crash)');
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
        assert(!('buyerIntake' in m.view), `${role} payload carries no buyerIntake key`);
      }
    }
  }

  // ---------------- conditional required validation (Anuraj, Oct 1) -----
  {
    // (d) Unanswered toggles ('') skip the pair entirely.
    const untouched = emptyBuyerIntake();
    assert(
      Object.keys(validateBuyerIntakeConditional(untouched)).length === 0,
      'unanswered toggles -> no violations',
    );

    // (a) Yes + empty follow-up -> blocked with the exact approved copy.
    const emptyPairs = emptyBuyerIntake();
    emptyPairs.investigation = 'yes';
    emptyPairs.appraisal = 'yes';
    emptyPairs.loan = 'yes';
    emptyPairs.hoa = 'yes';
    emptyPairs.solar = 'yes';
    const ev = validateBuyerIntakeConditional(emptyPairs);
    assert(ev.investigationDays === 'Enter the investigation period in days.', 'investigation yes + empty days -> error');
    assert(ev.appraisalDays === 'Enter the appraisal period in days.', 'appraisal yes + empty days -> error');
    assert(ev.loanDays === 'Enter the loan period in days.', 'loan yes + empty days -> error');
    assert(ev.hoaAmount === 'Enter the HOA amount per month.', 'hoa yes + empty amount -> error');
    assert(ev.solarLeasedOwned === 'Say whether the solar is leased or owned.', 'solar yes + empty leased/owned -> error');
    assert(ev.solarAmount === 'Enter the solar amount.', 'solar yes + empty amount -> error');
    assert(Object.keys(ev).length === 6, 'all violations collected at once (6)');

    // (b) Yes + valid follow-ups -> saves clean.
    const valid = emptyBuyerIntake();
    valid.investigation = 'yes';
    valid.investigationDays = '17';
    valid.appraisal = 'yes';
    valid.appraisalDays = '21';
    valid.loan = 'yes';
    valid.loanDays = '21';
    valid.hoa = 'yes';
    valid.hoaAmount = '250';
    valid.solar = 'yes';
    valid.solarLeasedOwned = 'leased';
    valid.solarAmount = '18000';
    assert(
      Object.keys(validateBuyerIntakeConditional(valid)).length === 0,
      'yes + valid follow-ups -> no violations',
    );

    // (c) No -> pair skipped, even with stale follow-up values.
    const no = emptyBuyerIntake();
    no.investigation = 'no';
    no.investigationDays = 'garbage';
    no.solar = 'no';
    no.solarAmount = 'garbage';
    assert(
      Object.keys(validateBuyerIntakeConditional(no)).length === 0,
      'no -> no violations regardless of follow-up values',
    );

    // (e) Non-numeric / non-positive follow-ups -> blocked.
    const bad = emptyBuyerIntake();
    bad.investigation = 'yes';
    bad.investigationDays = 'abc';
    bad.hoa = 'yes';
    bad.hoaAmount = '0';
    bad.solar = 'yes';
    bad.solarLeasedOwned = 'owned';
    bad.solarAmount = '-5';
    const eb = validateBuyerIntakeConditional(bad);
    assert(eb.investigationDays === 'Enter a number.', 'non-numeric days -> Enter a number.');
    assert(eb.hoaAmount === 'Enter a number.', 'zero amount -> Enter a number.');
    assert(eb.solarAmount === 'Enter a number.', 'negative amount -> Enter a number.');

    // Whitespace-only counts as empty.
    const ws = emptyBuyerIntake();
    ws.appraisal = 'yes';
    ws.appraisalDays = '   ';
    assert(
      validateBuyerIntakeConditional(ws).appraisalDays === 'Enter the appraisal period in days.',
      'whitespace-only days -> empty copy',
    );

    // Decimals are valid positive numbers.
    const dec = emptyBuyerIntake();
    dec.hoa = 'yes';
    dec.hoaAmount = '250.50';
    assert(
      Object.keys(validateBuyerIntakeConditional(dec)).length === 0,
      'decimal amount -> no violations',
    );
  }

  // -------------------------------------- structural guards (route files) --
  {
    // Both dates on the buyer intake form are optional AND clearable: the
    // form wires the shared clear control (Anuraj's Oct 1 standing rule).
    const form = repoFile('app/buyer-intake/[escrowId].tsx');
    for (const testID of ['buyer-intake-close-date', 'buyer-intake-possession-date']) {
      const idx = form.indexOf(`testID="${testID}"`);
      assert(idx !== -1, `buyer intake form renders ${testID}`);
      const block = form.slice(Math.max(0, idx - 400), idx);
      assert(block.includes('onClear'), `${testID} wires the clear control`);
    }

    // Conditional required validation (Anuraj, Oct 1): onSave validates
    // before the save call, and every follow-up control carries the inline
    // error prop. Never validated while typing.
    const saveIdx = form.indexOf('const onSave = async ()');
    assert(saveIdx !== -1, 'buyer intake form defines onSave');
    const saveBlock = form.slice(saveIdx, saveIdx + 600);
    assert(
      saveBlock.includes('validateBuyerIntakeConditional(form)'),
      'onSave runs the conditional validation',
    );
    assert(
      saveBlock.indexOf('setErrors(violations)') < saveBlock.indexOf('store.saveBuyerIntake'),
      'violations block the save call',
    );
    for (const [testID, key] of [
      ['buyer-intake-investigation-days', 'investigationDays'],
      ['buyer-intake-appraisal-days', 'appraisalDays'],
      ['buyer-intake-loan-days', 'loanDays'],
      ['buyer-intake-hoa-amount', 'hoaAmount'],
      ['buyer-intake-solar-amount', 'solarAmount'],
    ] as const) {
      const idx = form.indexOf(`testID="${testID}"`);
      assert(idx !== -1, `buyer intake form renders ${testID}`);
      const block = form.slice(Math.max(0, idx - 500), idx);
      assert(block.includes(`error={errors.${key} ?? null}`), `${testID} carries the inline error prop`);
    }
    {
      const idx = form.indexOf('testID="buyer-intake-solar-leased-owned"');
      assert(idx !== -1, 'buyer intake form renders buyer-intake-solar-leased-owned');
      const block = form.slice(Math.max(0, idx - 600), idx);
      assert(block.includes('error={errors.solarLeasedOwned ?? null}'), 'solar leased/owned seg carries the inline error prop');
    }
    // "No" clears the follow-ups in the toggle onChange handlers.
    for (const [toggle, followup] of [
      ['buyer-intake-investigation', 'investigationDays'],
      ['buyer-intake-appraisal', 'appraisalDays'],
      ['buyer-intake-loan', 'loanDays'],
      ['buyer-intake-hoa', 'hoaAmount'],
      ['buyer-intake-solar', 'solarAmount'],
    ] as const) {
      const idx = form.indexOf(`testID="${toggle}"`);
      assert(idx !== -1, `buyer intake form renders ${toggle}`);
      const block = form.slice(Math.max(0, idx - 600), idx);
      assert(block.includes(`${followup}: v === 'yes' ?`), `"No" on ${toggle} clears ${followup}`);
    }

    // Errors clear on edit: the update() helper drops error entries for
    // the fields being changed.
    const updateIdx = form.indexOf('const update = (patch: Partial<BuyerIntakeData>)');
    assert(updateIdx !== -1, 'buyer intake form defines update()');
    const updateBlock = form.slice(updateIdx, updateIdx + 700);
    assert(updateBlock.includes('setErrors'), 'update() clears field errors on edit');

    // YesNoSeg gained an error prop mirroring Field's red hint style.
    const seg = repoFile('src/components/YesNoSeg.tsx');
    assert(seg.includes('error?: string | null'), 'YesNoSeg accepts an error prop');
    assert(seg.includes('testID ? `${testID}-error` : undefined'), 'YesNoSeg error carries the -error testID');
    assert(seg.includes('styles.segError'), 'YesNoSeg renders the error style');

    // Save toast (Anuraj, Oct 1, 2026): mirrors the TC intake pattern
    // verbatim — showToast with 2400ms auto-dismiss, same pill styling.
    assert(form.includes("showToast('Buyer intake saved.')"), 'buyer intake shows the save toast with the approved copy');
    assert(form.includes('setTimeout(() => setToastMsg(null), 2400)'), 'toast auto-dismisses after 2400ms like TC');
    assert(form.includes('testID="toast"'), 'toast pill carries the toast testID');
    {
      // The toast fires only on successful save: the showToast('Buyer intake
      // saved.') call sits in onSave's try block after saveBuyerIntake, and
      // the catch block (save failure) never toasts.
      const onSaveIdx = form.indexOf('const onSave = async ()');
      const onSaveEnd = form.indexOf('};', form.indexOf('setSaving(false);', onSaveIdx));
      const onSaveBody = form.slice(onSaveIdx, onSaveEnd);
      const tryIdx = onSaveBody.indexOf('try {');
      const catchIdx = onSaveBody.indexOf('} catch');
      const toastCall = onSaveBody.indexOf("showToast('Buyer intake saved.')");
      assert(tryIdx !== -1 && catchIdx !== -1 && toastCall !== -1, 'onSave has try/catch and the toast call');
      assert(toastCall > tryIdx && toastCall < catchIdx, 'toast fires only on successful save, never on failure');
    }

    // Entry-row side gating: the row renders below the time tracker on both
    // render sites, buyer-side only.
    const detail = repoFile('app/escrow/[id].tsx');
    const entries = detail.match(/<BuyerIntakeEntryRow /g) ?? [];
    assert(entries.length === 2, 'buyer intake entry row renders at both detail render sites');
    assert(detail.includes('showBuyerIntakeForRealtorSide'), 'entry row is side-gated');

    // TC card side gating: "View buyer details" below the listing-details
    // card, buyer-side TC views only.
    const tc = repoFile('app/client/tc/[id].tsx');
    const listingIdx = tc.indexOf('testID="tc-view-listing-details"');
    const buyerIdx = tc.indexOf('testID="tc-view-buyer-details"');
    assert(listingIdx !== -1 && buyerIdx !== -1 && buyerIdx > listingIdx, '"View buyer details" sits below the listing-details card');
    assert(tc.includes('showBuyerDetailsForTcView'), 'TC card is side-gated');
  }

  summary('buyer_intake');
}

main().catch((err) => {
  console.error('FATAL -', err);
  process.exitCode = 1;
});
