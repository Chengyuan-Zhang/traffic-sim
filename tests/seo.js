// Invariant tests for the site's discoverability metadata.
//
//   node tests/seo.js
//
// Companion to invariants.js: that suite polices the physics, this one polices
// everything a crawler, a social card renderer or an answer engine reads. It is
// here because search metadata rots silently — a renamed section breaks an
// anchor, a reworded paragraph leaves the FAQ JSON-LD quoting text that is no
// longer on the page, a new page never reaches the sitemap — and none of those
// show up in a browser, in the simulation, or in a diff you are skimming.
//
// The strongest assertion in this file is the last kind: every question and
// answer in the FAQPage graph, every HowTo step and every glossary definition
// must appear verbatim in the page's *visible* text, with scripts and styles
// stripped first. Structured data that promises something the page does not say
// is the one search-engine offence that gets a site penalised rather than
// merely ignored, and it is exactly the kind of drift an editor introduces
// without noticing.
//
// Parsing is done with regular expressions rather than a DOM library, which is
// only defensible because this is a small static site whose markup is written
// by hand in this repository. If that stops being true, bring a parser.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BASE = 'https://chengyuan-zhang.github.io/traffic-sim/';

// The pages that are meant to be indexed, and the canonical URL each must claim.
const PAGES = [
  ['index.html', BASE],
  ['compare.html', BASE + 'compare.html'],
  ['models.html', BASE + 'models.html'],
];

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed: !!passed });
  const tag = passed ? 'ok  ' : 'FAIL';
  console.log(`${tag} ${name}${detail ? `\n       ${detail}` : ''}`);
}
function section(title) { console.log(`\n--- ${title} ---`); }

const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(REPO, f));

// --- tiny HTML helpers ----------------------------------------------------
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', times: '×', hellip: '…',
};
function decodeEntities(s) {
  return s.replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}
// Tags a browser renders without introducing whitespace. Dropping them rather
// than replacing them with a space is what makes "research-<em>inspired</em>"
// read back as "research-inspired", the way a person actually sees it — get
// this wrong and the verbatim checks below fail on punctuation instead of on
// the drift they exist to catch.
const INLINE = /^(a|abbr|b|bdi|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)$/i;

// Visible text only: script and style contents are removed first, so a claim
// can never be "found on the page" because it is in the JSON-LD blob.
function visibleText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?([a-zA-Z0-9]+)\b[^>]*>/g, (m, tag) => (INLINE.test(tag) ? '' : ' '))
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
function metaContent(html, attr, value) {
  const re = new RegExp(
    `<meta[^>]*\\b${attr}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i'
  );
  const tag = re.exec(html);
  if (!tag) return null;
  const c = /\bcontent=["']([\s\S]*?)["']/i.exec(tag[0]);
  return c ? decodeEntities(c[1]) : null;
}
const meta = (html, name) => metaContent(html, 'name', name);
const og = (html, prop) => metaContent(html, 'property', prop);
function linkHref(html, rel) {
  const re = new RegExp(`<link[^>]*\\brel=["']${rel}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return null;
  const h = /\bhref=["']([^"']+)["']/i.exec(tag[0]);
  return h ? h[1] : null;
}
function jsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.map((b) => JSON.parse(b[1]));
}
function ids(html) {
  return [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
}
// Every node in a JSON-LD graph, at any nesting depth.
function walk(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === 'object') {
    out.push(node);
    Object.values(node).forEach((v) => walk(v, out));
  }
  return out;
}
function pngSize(file) {
  const b = fs.readFileSync(path.join(REPO, file));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const docs = new Map(PAGES.map(([f]) => [f, read(f)]));

// ===========================================================================
section('Per-page metadata');

const titles = new Map();
const descriptions = new Map();

for (const [file, canonical] of PAGES) {
  const html = docs.get(file);

  check(`${file}: declares its language`,
        /<html\s+lang=["']en["']/.test(html));

  const title = (/<title>([\s\S]*?)<\/title>/.exec(html) || [])[1];
  titles.set(file, title);
  // 65 is roughly where Google starts truncating a desktop result; a title that
  // is cut off is a title whose tail was written for nobody.
  check(`${file}: has a title of usable length`,
        title && title.length >= 10 && title.length <= 65,
        `${title ? title.length : 'no'} chars: ${title || ''}`);

  const desc = meta(html, 'description');
  descriptions.set(file, desc);
  check(`${file}: has a description of usable length`,
        desc && desc.length >= 70 && desc.length <= 160,
        `${desc ? desc.length : 'no'} chars`);

  check(`${file}: canonical points at its own published URL`,
        linkHref(html, 'canonical') === canonical,
        `canonical = ${linkHref(html, 'canonical')}`);

  const robots = meta(html, 'robots') || '';
  check(`${file}: is indexable and allows large previews`,
        !/noindex/i.test(robots) && /index/i.test(robots) && /max-image-preview:large/i.test(robots),
        robots || '(no robots meta)');

  // og:url disagreeing with the canonical is the classic way to split a page's
  // signals between two URLs.
  check(`${file}: og:url agrees with the canonical`,
        og(html, 'og:url') === canonical,
        `og:url = ${og(html, 'og:url')}`);

  const required = ['og:title', 'og:description', 'og:image', 'og:type', 'og:site_name', 'og:locale'];
  const missing = required.filter((p) => !og(html, p));
  check(`${file}: carries a complete Open Graph card`, missing.length === 0,
        missing.length ? `missing ${missing.join(', ')}` : 'all present');

  check(`${file}: twitter card is the large-image variant with alt text`,
        meta(html, 'twitter:card') === 'summary_large_image' &&
          !!meta(html, 'twitter:image') && !!meta(html, 'twitter:image:alt'));

  // A social image whose declared size is wrong renders cropped or not at all.
  const imgUrl = og(html, 'og:image');
  const localImg = imgUrl && imgUrl.startsWith(BASE) ? imgUrl.slice(BASE.length) : null;
  const declared = { width: +og(html, 'og:image:width'), height: +og(html, 'og:image:height') };
  const actual = localImg && exists(localImg) ? pngSize(localImg) : null;
  check(`${file}: og:image exists and its declared dimensions are the real ones`,
        actual && actual.width === declared.width && actual.height === declared.height,
        actual
          ? `declared ${declared.width}x${declared.height}, actual ${actual.width}x${actual.height}`
          : `could not read ${imgUrl}`);

  // Google will not show a favicon it cannot crawl, which rules out the
  // data: URI this site used to carry.
  const icon = linkHref(html, 'icon');
  check(`${file}: favicon is a crawlable file, not a data: URI`,
        icon && !icon.startsWith('data:') && exists(icon), `rel=icon -> ${icon}`);

  const manifest = linkHref(html, 'manifest');
  check(`${file}: web app manifest resolves`, manifest && exists(manifest), `${manifest}`);
}

check('every indexable page has a distinct title',
      new Set(titles.values()).size === PAGES.length);
check('every indexable page has a distinct description',
      new Set(descriptions.values()).size === PAGES.length);

// ===========================================================================
section('Document structure');

for (const [file] of PAGES) {
  const html = docs.get(file);

  const h1s = [...html.matchAll(/<h1\b/g)].length;
  check(`${file}: has exactly one h1`, h1s === 1, `found ${h1s}`);

  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => +m[1]);
  let skip = null;
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] > levels[i - 1] + 1) { skip = `h${levels[i - 1]} -> h${levels[i]}`; break; }
  }
  check(`${file}: heading levels never skip a rank`, skip === null, skip || levels.join(' '));

  const pageIds = ids(html);
  const dupes = pageIds.filter((id, i) => pageIds.indexOf(id) !== i);
  check(`${file}: element ids are unique`, dupes.length === 0, dupes.join(', '));

  const imgs = [...html.matchAll(/<img\b[\s\S]*?>/g)].map((m) => m[0]);
  check(`${file}: every img carries an alt attribute`,
        imgs.every((t) => /\balt\s*=/.test(t)), `${imgs.length} images`);
}

// ===========================================================================
section('Links');

for (const [file] of PAGES) {
  const html = docs.get(file);
  const pageIds = new Set(ids(html));
  const refs = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)].map((m) => m[1]);

  // Mixed content is both a browser warning and a ranking signal.
  const insecure = refs.filter((r) => r.startsWith('http://'));
  check(`${file}: no insecure http:// references`, insecure.length === 0, insecure.join(', '));

  const local = refs.filter(
    (r) => !/^(https?:|mailto:|data:|#|\/\/)/.test(r) && r !== ''
  );
  const brokenFiles = local.filter((r) => !exists(r.split('#')[0]));
  check(`${file}: every relative reference resolves to a file`,
        brokenFiles.length === 0, brokenFiles.join(', ') || `${local.length} checked`);

  // Same-page anchors, including the ones the table of contents depends on.
  const sameDoc = refs.filter((r) => r.startsWith('#') && r.length > 1).map((r) => r.slice(1));
  const brokenAnchors = sameDoc.filter((id) => !pageIds.has(id));
  check(`${file}: every same-page anchor has a target`,
        brokenAnchors.length === 0, brokenAnchors.join(', ') || `${sameDoc.length} checked`);

  // Cross-page anchors: a link to models.html#idm is only useful if models.html
  // still has that id.
  const crossDoc = local.filter((r) => r.includes('#') && r.split('#')[0].endsWith('.html'));
  const brokenCross = crossDoc.filter((r) => {
    const [target, frag] = r.split('#');
    return !new Set(ids(read(target))).has(frag);
  });
  check(`${file}: every cross-page anchor has a target`,
        brokenCross.length === 0, brokenCross.join(', ') || `${crossDoc.length} checked`);
}

// ===========================================================================
section('Structured data');

for (const [file, canonical] of PAGES) {
  const html = docs.get(file);

  let graphs;
  try { graphs = jsonLd(html); } catch (e) { graphs = null; }
  check(`${file}: JSON-LD parses`, Array.isArray(graphs) && graphs.length === 1,
        graphs ? `${graphs.length} blocks` : 'JSON.parse threw');
  if (!graphs || graphs.length !== 1) continue;

  const doc = graphs[0];
  check(`${file}: JSON-LD uses the schema.org context`,
        doc['@context'] === 'https://schema.org');

  const nodes = walk(doc['@graph']);
  const defined = new Set(nodes.filter((n) => n['@id'] && n['@type']).map((n) => n['@id']));

  // Every @id this site mints must live under this site, or two pages will
  // describe two different entities that look like one.
  const foreign = [...new Set(nodes.map((n) => n['@id']).filter(Boolean))]
    .filter((id) => !id.startsWith(BASE));
  check(`${file}: every @id is namespaced under the site`, foreign.length === 0, foreign.join(', '));

  // A bare {"@id": "..."} is a reference; it has to point at a node the same
  // page defines, because crawlers resolve a page in isolation.
  const dangling = nodes
    .filter((n) => Object.keys(n).length === 1 && n['@id'])
    .map((n) => n['@id'])
    .filter((id) => !defined.has(id));
  check(`${file}: every @id reference resolves within the page`,
        dangling.length === 0, [...new Set(dangling)].join(', '));

  const page = nodes.find((n) => [].concat(n['@type']).some(
    (t) => t === 'WebPage' || t === 'TechArticle'
  ));
  check(`${file}: the page node claims the canonical URL`,
        page && page.url === canonical, page ? `url = ${page.url}` : 'no WebPage/TechArticle node');

  // The visible "updated" date and the machine-readable one must not diverge.
  const footerTime = (/<time datetime=["']([^"']+)["']/.exec(html) || [])[1];
  check(`${file}: dateModified matches the date shown in the footer`,
        page && footerTime && page.dateModified === footerTime,
        `JSON-LD ${page && page.dateModified} vs footer ${footerTime}`);

  // --- the important one: no structured-data claim the page does not make ---
  const text = visibleText(html);

  const faq = nodes.find((n) => n['@type'] === 'FAQPage');
  if (faq) {
    const unseen = [];
    for (const q of faq.mainEntity) {
      if (!text.includes(q.name)) unseen.push(`Q: ${q.name}`);
      if (!text.includes(q.acceptedAnswer.text)) unseen.push(`A: ${q.name}`);
    }
    check(`${file}: every FAQ question and answer appears verbatim on the page`,
          unseen.length === 0, unseen.join(' | ') || `${faq.mainEntity.length} pairs`);
  }

  const howto = nodes.find((n) => n['@type'] === 'HowTo');
  if (howto) {
    const unseen = howto.step.filter((s) => !text.includes(s.text)).map((s) => s.name);
    check(`${file}: every HowTo step appears verbatim on the page`,
          unseen.length === 0, unseen.join(', ') || `${howto.step.length} steps`);
  }

  const terms = nodes.find((n) => n['@type'] === 'DefinedTermSet');
  if (terms) {
    const unseen = terms.hasDefinedTerm
      .filter((t) => !text.includes(t.name) || !text.includes(t.description))
      .map((t) => t.name);
    check(`${file}: every glossary definition appears verbatim on the page`,
          unseen.length === 0, unseen.join(', ') || `${terms.hasDefinedTerm.length} terms`);
  }
}

// ===========================================================================
section('Crawl files');

{
  const robots = read('robots.txt');
  check('robots.txt allows the default crawler',
        /User-agent:\s*\*/i.test(robots) && /\n\s*Allow:\s*\//i.test(robots));
  check('robots.txt disallows nothing',
        !/^\s*Disallow:\s*\/\s*$/im.test(robots));
  check('robots.txt advertises the sitemap',
        robots.includes(`Sitemap: ${BASE}sitemap.xml`));

  const sitemap = read('sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const canonicals = PAGES.map(([, url]) => url);
  check('sitemap lists exactly the indexable pages',
        locs.length === canonicals.length && canonicals.every((u) => locs.includes(u)),
        `sitemap: ${locs.join(', ')}`);

  const lastmods = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
  check('every sitemap entry carries a well-formed lastmod',
        lastmods.length === locs.length &&
          lastmods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d))),
        lastmods.join(', '));

  // A page that says "updated today" while the sitemap says otherwise teaches a
  // crawler to stop trusting the sitemap.
  const pageDate = (/<time datetime=["']([^"']+)["']/.exec(docs.get('index.html')) || [])[1];
  check('sitemap lastmod agrees with the date the site displays',
        lastmods.every((d) => d === pageDate), `sitemap ${lastmods[0]} vs page ${pageDate}`);

  check('404 page is excluded from the index',
        /noindex/i.test(meta(read('404.html'), 'robots') || ''));
}

{
  const llms = read('llms.txt');
  check('llms.txt opens with a title and a summary blockquote',
        /^#\s+\S/.test(llms) && /\n>\s+\S/.test(llms));
  // Any link it makes back into this site has to resolve, or the file sends
  // models somewhere that 404s. Split on the base URL rather than building a
  // regex out of it: the path that follows runs to the first ")" or space.
  const siteLinks = llms
    .split(BASE)
    .slice(1)
    .map((rest) => (/^[^)\s]*/.exec(rest) || [''])[0])
    .filter((p) => !p.startsWith('#'))
    .map((p) => (p === '' ? 'index.html' : p));
  const broken = siteLinks.filter((p) => !exists(p.split('#')[0]));
  check('every traffic-sim link in llms.txt resolves',
        broken.length === 0, broken.join(', ') || `${siteLinks.length} checked`);

  const cff = read('CITATION.cff');
  check('CITATION.cff has the fields GitHub needs to render a citation',
        /^cff-version:\s*1\.2\.0/m.test(cff) && /^title:/m.test(cff) &&
          /^authors:/m.test(cff) && /^message:/m.test(cff));

  let manifest = null;
  try { manifest = JSON.parse(read('site.webmanifest')); } catch (e) { /* reported below */ }
  check('site.webmanifest is valid JSON with a name and icons',
        manifest && manifest.name && Array.isArray(manifest.icons) && manifest.icons.length > 0);
  if (manifest) {
    const assets = [...manifest.icons, ...(manifest.screenshots || [])].map((i) => i.src);
    const missing = assets.filter((src) => !exists(src));
    check('every manifest asset exists', missing.length === 0, missing.join(', ') || assets.join(', '));
  }
}

// ===========================================================================
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
