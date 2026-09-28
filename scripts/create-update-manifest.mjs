import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

// Usage: node scripts/create-update-manifest.mjs VERSION OWNER/REPO INSTALLER_PATH SIGNATURE_PATH OUTPUT_PATH
const [version, repository, installerPath, signaturePath, outputPath] = process.argv.slice(2);
if (!version || !repository || !installerPath || !signaturePath || !outputPath) {
  throw new Error('Usage: VERSION OWNER/REPO INSTALLER_PATH SIGNATURE_PATH OUTPUT_PATH');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Version must be SemVer');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Repository must be OWNER/REPO');
const installer = await readFile(installerPath);
const signature = (await readFile(signaturePath, 'utf8')).trim();
if (installer.length < 1024 || !signature) throw new Error('Installer or signature is empty');
const asset = encodeURIComponent(basename(installerPath));
const manifest = {
  version,
  notes: 'Mise à jour de l’application de soumissions et factures.',
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repository}/releases/download/v${version}/${asset}`,
    },
  },
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(`Created update manifest for v${version}`);
