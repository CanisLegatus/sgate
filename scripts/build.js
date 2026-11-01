'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const escapeEnd = text => text.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="app/styles.css">', () => '<style>\n' + fs.readFileSync(path.join(root, 'app/styles.css'), 'utf8') + '\n</style>');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => '<script>\n' + escapeEnd(fs.readFileSync(path.join(root, src), 'utf8')) + '\n</script>');
// A library string can itself contain </body>. Insert at the final actual tag.
const end = html.lastIndexOf('</body>');
if (end < 0) throw new Error('Missing body end');
html = html.slice(0, end) + '<script type="text/plain" id="sheetjs-license">\n' + escapeEnd(fs.readFileSync(path.join(root, 'vendor/SHEETJS-LICENSE.txt'), 'utf8')) + '\n</script>\n' + html.slice(end);
if (/<(?:script|link)[^>]+(?:src|href)=/.test(html)) throw new Error('Standalone build still has external resources');
let scripts = 0;
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new vm.Script(match[1], { filename: 'embedded-' + (++scripts) + '.js' });
}
if (scripts !== 5) throw new Error('Expected five executable scripts, got ' + scripts);
fs.writeFileSync(path.join(root, 'sgate.html'), html);
console.log('sgate.html: ' + Math.round(Buffer.byteLength(html) / 1024) + ' KiB, offline, ' + scripts + ' scripts syntax-checked');
