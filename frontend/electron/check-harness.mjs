// Tiny dependency-free harness shared by the *.check.mjs scripts (not itself a check).
import assert from 'assert';
export { assert };

let failed = 0;
let total = 0;

/** Run one named check; a throw is a FAIL line, never aborts the others. */
export async function check(name, fn) {
  total++;
  try { await fn(); console.log(`ok    ${name}`); } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(err?.message ?? err).split('\n').join('\n      ')}`);
  }
}

/** Dynamic import that turns a missing module into a readable failure. */
export async function need(spec) {
  try { return await import(spec); } catch (err) {
    throw new Error(`module ${spec} cannot be imported: ${err.code ?? ''} ${String(err.message).split('\n')[0]}`);
  }
}

/** Assert that module `m` exports function `name`. */
export function needFn(m, name, spec) {
  if (typeof m[name] !== 'function') throw new Error(`missing export ${name} in ${spec}`);
  return m[name];
}

export function finish(label) {
  console.log(`${label}: ${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
}
