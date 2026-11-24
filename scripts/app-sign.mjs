// The step where paid signing goes (files-direct-34, docs/DESKTOP-RUNG2.md): it runs on the built files, before the list of updates is signed, so a later paid certificate
// is added here, as a step with secrets, without rebuilding the app. Today there is no certificate: with none of its secrets set it says so and leaves the files as built.
// With any of them set it stops, so that a half-set-up signing is never mistaken for a finished one.
//   node scripts/app-sign.mjs <folder with the built files>
const NAMES = ['APPLE_DEVELOPER_ID_P12_BASE64', 'APPLE_DEVELOPER_ID_P12_PASSWORD', 'APPLE_NOTARY_KEY_ID', 'APPLE_NOTARY_ISSUER_ID', 'APPLE_NOTARY_KEY_P8_BASE64', 'WINDOWS_SIGNING_CERT_PFX_BASE64', 'WINDOWS_SIGNING_CERT_PASSWORD'];
const set = NAMES.filter((n) => process.env[n]);
if (!process.argv[2]) {
  console.error('usage: node scripts/app-sign.mjs <folder>');
  process.exit(2);
}
if (set.length === 0) {
  console.log('No paid signing is set up (none of ' + NAMES.length + ' signing secrets is set): the files stay as built. The Mac app carries an ad hoc signature and the Windows installer none.');
  process.exit(0);
}
console.error('Signing secrets are set (' + set.join(', ') + ') but the signing step is not written yet (docs/DESKTOP-RUNG2.md says what it does). Nothing was signed and nothing is published.');
process.exit(1);
