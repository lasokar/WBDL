const fs = require('fs');
const path = require('path');
const lists = require('./public/list-config');
const templatePath = path.join(__dirname, "public");
const templates = new Map();

function escapeAttribute(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pageTitle(original, filename, list) {
    if (filename === 'index.html') return list.title;
    if (list.id === 'primary') return original;
    return /WBDL/i.test(original)
        ? original.replace(/WBDL/gi, list.shortName)
        : `${original} | ${list.shortName}`;
}

function renderPage(html, filename, listType, pathname = '/', origin = 'https://webdemonlist.org') {
    const list = lists.get(listType);
    const original = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || list.title;
    const title = pageTitle(original, filename, list);
    const canonical = new URL(pathname, origin).href;
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeAttribute(title)}</title>`)
        .replace(/<meta\b[^>]*(?:name|property)=["'](?:title|description|theme-color|og:[^"']+|twitter:[^"']+)["'][^>]*>\s*/gi, '')
        .replace(/<link\b[^>]*rel=["'](?:icon|canonical|apple-touch-icon)["'][^>]*>\s*/gi, '');
    const image = new URL(list.icon, origin).href;
    const tags = [
        ['name', 'title', title], ['name', 'description', list.description], ['name', 'theme-color', list.color],
        ['property', 'og:type', 'website'], ['property', 'og:site_name', list.brand],
        ['property', 'og:url', canonical], ['property', 'og:title', title],
        ['property', 'og:description', list.description], ['property', 'og:image', image],
        ['property', 'og:image:alt', list.brand], ['name', 'twitter:card', 'summary_large_image'],
        ['name', 'twitter:url', canonical], ['name', 'twitter:title', title],
        ['name', 'twitter:description', list.description], ['name', 'twitter:image', image]
    ].map(([attribute, key, value]) => `    <meta ${attribute}="${key}" content="${escapeAttribute(value)}">`).join('\n');
    return html.replace(/<\/head>/i, `${tags}\n    <link rel="icon" type="${list.icon.endsWith('.svg') ? 'image/svg+xml' : 'image/png'}" href="${list.icon}">\n    <link rel="canonical" href="${escapeAttribute(canonical)}">\n</head>`)
        .replace(/<body\b([^>]*)>/i, (tag, attrs) => {
            const theme = list.id === 'primary' ? '' : `${list.id}-list`;
            if (!theme) return tag;
            return /\bclass=/i.test(attrs)
                ? `<body${attrs.replace(/class=(["'])(.*?)\1/i, (_, quote, classes) => `class=${quote}${classes} ${theme}${quote}`)}>`
                : `<body${attrs} class="${theme}">`;
        });
}

function sendListPage(req, res, filename) {
    if (!templates.has(filename)) templates.set(filename, fs.readFileSync(path.join(templatePath, filename), 'utf8'));
    const requestHost = String(req.headers.host || 'webdemonlist.org');
    const protocol = /^(?:(?:impossible|challenge)\.)?webdemonlist\.org(?::\d+)?$/i.test(requestHost) ? 'https' : (req.protocol || 'http');
    const origin = `${protocol}://${requestHost}`;
    res.set('Vary', 'Host');
    return res.type('html').send(renderPage(templates.get(filename), filename, req.currentList, req.originalUrl || req.path, origin));
}

function htmlFiles(req, res, next) {
    if (!['GET', 'HEAD'].includes(req.method) || !/^\/[a-z-]+\.html$/i.test(req.path)) return next();
    const filename = req.path.slice(1);
    if (filename === 'roulette.html' && req.currentList === 'impossible') {
        return res.status(404).send('Roulette is not available on the ILL.');
    }
    if (!fs.existsSync(path.join(templatePath, filename))) return next();
    if (filename === 'admin.html' || filename === 'moderators.html') return res.redirect(302, '/' + filename.replace('.html', ''));
    return sendListPage(req, res, filename);
}

module.exports = { renderPage, sendListPage, htmlFiles };
