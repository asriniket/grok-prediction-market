import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateAnchorReference, generateReference } from './generate.js';
import { promptPairArtifact, type Side } from './scaffold.js';

/**
 * Generate and LOCK the champion reference images.
 *
 *   npm run champions:lock
 *
 * The spec's first instruction, before anything else: regenerating references
 * mid-build causes character drift and collapses the consistency claim on
 * stage. Run this ONCE, commit the output, never run it again.
 *
 * Locking downloads the bytes rather than storing the URL, because generated
 * image URLs are served from an `xai-tmp-imgen` path and should be treated as
 * ephemeral.
 */

const OUT_DIR = resolve(process.cwd(), 'assets/champions');

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download reference: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const sides: Side[] = ['affirmative', 'negative'];
  const locked: Record<string, unknown> = {};

  for (const side of sides) {
    const ref = await generateReference(side);
    const bytes = await download(ref.url);
    const name = side === 'affirmative' ? 'vera' : 'kane';
    const file = resolve(OUT_DIR, `${name}.jpg`);
    writeFileSync(file, bytes);

    locked[name] = {
      side,
      file: `assets/champions/${name}.jpg`,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      prompt: ref.prompt,
      sourceUrl: ref.url,
    };
    console.log(`locked ${name}: ${bytes.byteLength} bytes -> assets/champions/${name}.jpg`);
  }

  // The anchor is locked alongside the debaters, but is not part of the
  // symmetry pair — it argues no side.
  const anchor = await generateAnchorReference();
  const anchorBytes = await download(anchor.url);
  writeFileSync(resolve(OUT_DIR, 'anchor.jpg'), anchorBytes);
  locked.anchor = {
    role: 'anchor',
    file: 'assets/champions/anchor.jpg',
    bytes: anchorBytes.byteLength,
    sha256: createHash('sha256').update(anchorBytes).digest('hex'),
    prompt: anchor.prompt,
    sourceUrl: anchor.url,
  };
  console.log(`locked anchor: ${anchorBytes.byteLength} bytes -> assets/champions/anchor.jpg`);

  const artifact = promptPairArtifact();
  const lockFile = resolve(OUT_DIR, 'champions.lock.json');
  writeFileSync(
    lockFile,
    JSON.stringify(
      {
        note: 'Generated once and locked. Do not regenerate — character drift breaks the consistency claim.',
        symmetric: artifact.symmetric,
        symmetryViolations: artifact.violations,
        champions: locked,
        promptPair: { affirmative: artifact.affirmative, negative: artifact.negative },
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${lockFile}`);
  console.log(`symmetric: ${artifact.symmetric}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
