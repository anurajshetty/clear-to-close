// Tiny assert helper for the node test suites (no framework).

declare const process: { exitCode?: number };

let failures = 0;

export function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log('ok   - ' + msg);
  } else {
    failures++;
    console.error('FAIL - ' + msg);
  }
}

export function summary(name: string): void {
  if (failures > 0) {
    console.error(`\n${name}: ${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\n${name}: all green`);
  }
}
