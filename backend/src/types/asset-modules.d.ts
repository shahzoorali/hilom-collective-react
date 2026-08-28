/**
 * Non-code imports resolved by the bundler, not by tsc.
 *
 * The Lambda build (infra/lib/hilom-shared.ts) registers an esbuild `binary`
 * loader for `.pdf`, so `import pdf from './x.pdf'` yields the file's bytes.
 * tsc never reads the file — this ambient declaration is all it needs.
 */
declare module '*.pdf' {
  const data: Uint8Array;
  export default data;
}
