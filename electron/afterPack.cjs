// Après l'empaquetage macOS : signature « ad hoc » (sans certificat Apple). Sans elle, les Mac Apple Silicon refusent de lancer l'application.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
exports.default = async ({ appOutDir, packager, electronPlatformName }) => {
  if (electronPlatformName !== 'darwin') return;
  const app = path.join(appOutDir, packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  • signature ad hoc appliquée à ' + path.basename(app));
};
