import { minify } from 'html-minifier-terser';
import fs from 'fs';
import path from 'path';

const sourceDir = 'front-end/sb';
const outputDir = 'dist/front-end/sb';

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

// static assets are copied verbatim; only index.html gets minified
for (const entry of fs.readdirSync(sourceDir)) {
  if (entry === 'index.html') continue;
  fs.copyFileSync(path.join(sourceDir, entry), path.join(outputDir, entry));
}

const input = fs.readFileSync(path.join(sourceDir, 'index.html'), 'utf8');

minify(input, {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
  removeRedundantAttributes: true,
  useShortDoctype: true,
  removeEmptyAttributes: true,
}).then((minified) => {
  fs.writeFileSync(path.join(outputDir, 'index.html'), minified);
  console.log('Minification complete: dist/front-end/sb/index.html');
});
