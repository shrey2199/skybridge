import { minify } from 'html-minifier-terser';
import fs from 'fs';

const input = fs.readFileSync('front-end/sb/index.html', 'utf8');

minify(input, {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
  removeRedundantAttributes: true,
  useShortDoctype: true,
  removeEmptyAttributes: true,
}).then((minified) => {
  fs.writeFileSync('front-end/sb/index.html', minified);
  console.log('Minification complete!');
});
