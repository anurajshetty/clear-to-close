// clients_kicker.test.ts — REGRESSION: the View-clients sheet kicker used
// to read "CLIENTS · <full address>". Anuraj's Sept 28, 2026 directive
// (with screenshot): the kicker is just "CLIENTS" — no property address.
// Surgical change; the rest of the sheet is untouched. Structural test:
// RN components are not importable in the node suite, so this pins the
// rendered kicker text in the component source.
import { assert, summary } from './assert';

declare const require: any;
declare const process: { cwd(): string; env: Record<string, string | undefined>; exitCode?: number };
const fs = require('fs');
const path = require('path');

const ROOT = process.env.CTC_REPO_ROOT ?? process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const listSrc = read('src/components/ClientList.tsx');

const kickerLines = listSrc.split('\n').filter((l: string) => l.includes('<Kicker>'));
assert(kickerLines.length === 1, `ClientList: exactly one <Kicker> line, found ${kickerLines.length}`);
const kicker = kickerLines[0];
assert(
  kicker.includes("side === 'tc' ? 'TC' : 'Clients'"),
  'ClientList: kicker still shows TC / Clients per side',
);
assert(!kicker.includes('address'), 'ClientList: kicker contains no address');
assert(!kicker.includes('·'), 'ClientList: kicker has no middle-dot separator');

summary('clients_kicker');
