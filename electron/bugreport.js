/* « Signaler un bug » : ouvre dans le navigateur une nouvelle issue GitHub pré-remplie (version, système, écrans, fin du journal). */
import os from 'node:os';
import fs from 'node:fs';
import { screen } from 'electron';

const MAX_URL_BODY = 6500;        // au-delà, GitHub refuse l'adresse

export function bugReportUrl({ version, packaged, logFile, repoUrl }) {
  const sys = process.platform === 'darwin' ? 'macOS ' + process.getSystemVersion() : process.platform === 'win32' ? 'Windows ' + os.release() : os.type() + ' ' + os.release();
  const displays = screen.getAllDisplays().map((d, i) => `${d.label || 'Écran ' + (i + 1)} ${d.size.width}×${d.size.height} ×${d.scaleFactor}${d.internal ? ' (intégré)' : ''}`).join(' ; ') || 'aucun';
  let lines = [];
  try { lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-50); } catch { /* pas encore de journal */ }
  const head = `## Ce qui ne va pas

(Décris le problème : ce que tu faisais, ce qui s'est passé, ce que tu attendais.)

## Pour le reproduire

1. 
2. 

---
**Infos techniques (remplies automatiquement)**
- Régie LED ${version}${packaged ? '' : ' (développement)'} · Electron ${process.versions.electron}
- Système : ${sys} (${process.arch})
- Écrans : ${displays}

<details><summary>Journal (dernières lignes)</summary>

\`\`\`
`;
  const tail = '\n```\n</details>\n';
  let body = head + lines.join('\n') + tail;
  while (lines.length && encodeURIComponent(body).length > MAX_URL_BODY) { lines.shift(); body = head + lines.join('\n') + tail; }
  return `${repoUrl}/issues/new?labels=bug&body=${encodeURIComponent(body)}`;
}
