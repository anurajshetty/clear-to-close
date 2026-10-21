#!/usr/bin/env node
/**
 * Parse check for the edge-function sources and the generated
 * dashboard single files (Oct 21, 2026 — added after a handover
 * defect: a dashboard single carried a syntax error that grep-only
 * verification and the app tsc bar both missed, because
 * supabase/functions is outside the app tsconfig and grep cannot
 * see grammar).
 *
 * For every target file, parse with the TypeScript compiler's own
 * parser (createSourceFile) and fail if there is ANY parse
 * diagnostic. Parse-only: imports (including Deno URL imports) are
 * not resolved and nothing is type-checked — this answers exactly
 * one question: is this file syntactically valid TypeScript?
 *
 * Usage: node tools/parse_check.mjs [file ...]
 * With no arguments, checks the send-client-push sources and the
 * generated single in ~/workspace/your_files (when present).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const defaults = [
  join(repoRoot, 'supabase/functions/send-client-push/index.ts'),
  join(repoRoot, 'supabase/functions/send-client-push/push.ts'),
  join(repoRoot, '..', 'your_files', 'send-client-push-single.ts'),
];

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2).map((p) => resolve(p)) : defaults;

let failures = 0;
for (const file of targets) {
  if (!existsSync(file)) {
    console.log(`parse-check SKIP (absent): ${file}`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    failures++;
    for (const d of diags) {
      const pos = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      console.error(
        `parse-check FAIL: ${file}:${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      );
    }
  } else {
    console.log(`parse-check OK: ${file}`);
  }
}

if (failures > 0) {
  console.error(`parse-check: ${failures} file(s) with syntax errors — DO NOT SHIP`);
  process.exit(1);
}
