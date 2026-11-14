// Writes the installable instruction text from the SAME source the extension uses: `WMB.instructionsText()`
// (content_scripts/prompt_builder.js). One source, so the call frame and the result statuses of a chat where
// the rules live outside it (a Project / Gem) can never drift from the ones the extension expects.
//
//   npm run instructions
//
// · instructions/instructions.txt   plain text: what the user pastes into a Project / Gem instruction box
// · instructions/README.md          where to put it on each platform (hand-written, not generated)
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const context = vm.createContext({ console, setTimeout, clearTimeout });
for (const file of ['constants.js', 'utils.js', 'prompt_builder.js']) {
  vm.runInContext(readFileSync(`${root}/content_scripts/${file}`, 'utf8'), context);
}
const { WMB } = context;
const body = WMB.instructionsText();

mkdirSync(`${root}/instructions`, { recursive: true });
writeFileSync(`${root}/instructions/instructions.txt`, `${body}\n`);

console.log('✔ instructions/instructions.txt written');
console.log(`  build signature: ${WMB.buildSignature()} · ${body.length} characters`);