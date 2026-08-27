const WBDLIconRenderer = (() => {
    const ICON_CATEGORY_CONFIG = {
        cube: { key: 'cube', label: 'Cube', folder: 'cubes', prefix: 'player' },
        ship: { key: 'ship', label: 'Ship', folder: 'ships', prefix: 'ship' },
        ball: { key: 'ball', label: 'Ball', folder: 'balls', prefix: 'player_ball' },
        ufo: { key: 'ufo', label: 'UFO', folder: 'ufos', prefix: 'bird' },
        wave: { key: 'wave', label: 'Wave', folder: 'waves', prefix: 'dart' },
        robot: { key: 'robot', label: 'Robot', folder: 'robots', prefix: 'robot' },
        spider: { key: 'spider', label: 'Spider', folder: 'spiders', prefix: 'spider' },
        swing: { key: 'swing', label: 'Swing', folder: 'swings', prefix: 'swing' },
        jetpack: { key: 'jetpack', label: 'Jetpack', folder: 'jetpacks', prefix: 'jetpack' },
    };

    let colorsPromise = null;
    const animDescCache = {};

    function getCategory(type) {
        return ICON_CATEGORY_CONFIG[type] || ICON_CATEGORY_CONFIG.cube;
    }

    function getCategories() {
        return Object.values(ICON_CATEGORY_CONFIG);
    }

    function getAssetUrl(path) {
        return new URL(path.replace(/^\/+/, ''), window.location.origin + '/').href;
    }

    async function loadColors() {
        if (!colorsPromise) {
            colorsPromise = fetch('/assets/colors.json')
                .then(res => res.ok ? res.json() : {})
                .catch(() => ({}));
        }
        return colorsPromise;
    }

    async function getColor(colorId, fallback) {
        const colors = await loadColors();
        const color = colors[String(colorId)] || fallback;
        return {
            r: Number(color?.r ?? fallback.r),
            g: Number(color?.g ?? fallback.g),
            b: Number(color?.b ?? fallback.b),
        };
    }

    function parsePlistFrames(xmlText) {
        const cleaned = String(xmlText || '').replace(/^[^<]+/, '').replace(/<!DOCTYPE[^[>]*(?:\[[^\]]*\])?>/i, '');
        const doc = new DOMParser().parseFromString(cleaned, 'text/xml');

        function parseNode(el) {
            switch (el.tagName) {
                case 'dict': {
                    const obj = {};
                    const kids = Array.from(el.children);
                    for (let i = 0; i + 1 < kids.length; i += 2) {
                        obj[kids[i].textContent] = parseNode(kids[i + 1]);
                    }
                    return obj;
                }
                case 'array': return Array.from(el.children).map(parseNode);
                case 'string': return el.textContent;
                case 'integer': return parseInt(el.textContent, 10);
                case 'real': return parseFloat(el.textContent);
                case 'true': return true;
                case 'false': return false;
                default: return el.textContent;
            }
        }

        if (doc.querySelector('parsererror')) return {};
        const rootEl = doc.querySelector('plist > dict') || doc.querySelector('dict');
        if (!rootEl) return {};
        const root = parseNode(rootEl);
        return (root && root.frames) || root || {};
    }

    function parseGDCoord(str) {
        return ((str || '').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    }

    function normalizeAtlasFrame(frame) {
        if (!frame) return null;
        return {
            textureRect: frame.textureRect || frame.frame || frame.frameRect || frame.rect || null,
            spriteSourceSize: frame.spriteSourceSize || frame.sourceSize || frame.spriteSize || frame.spriteRect || null,
            spriteOffset: frame.spriteOffset || frame.offset || '{0,0}',
            textureRotated: frame.textureRotated ?? frame.rotated ?? false,
        };
    }

    function getAtlasRenderPrefix(frameKeys, baseName) {
        const hasMatchingFrames = frameKeys.some(key => key.startsWith(`${baseName}_`) && key.endsWith('_001.png'));
        return hasMatchingFrames ? baseName : null;
    }

    function compareAtlasLayers(left, right) {
        const parseInfo = (key) => {
            const tokens = key.replace(/_001\.png$/, '').split('_').slice(2);
            const isExtra = tokens.includes('extra');
            const isNumberedPart = !isExtra && tokens.length > 1 && /^\d+$/.test(tokens[1]);
            const priority = isExtra ? 2 : isNumberedPart ? 1 : 0;
            const normalizedTokens = tokens.map(token => (/^\d+$/.test(token) ? Number(token) : token));
            return { priority, tokens: normalizedTokens };
        };

        const leftInfo = parseInfo(left);
        const rightInfo = parseInfo(right);
        if (leftInfo.priority !== rightInfo.priority) return leftInfo.priority - rightInfo.priority;

        const maxLength = Math.max(leftInfo.tokens.length, rightInfo.tokens.length);
        for (let i = 0; i < maxLength; i++) {
            const l = leftInfo.tokens[i];
            const r = rightInfo.tokens[i];
            if (l === undefined) return -1;
            if (r === undefined) return 1;
            if (l === r) continue;
            if (typeof l === 'number' && typeof r === 'number') return l - r;
            if (typeof l === 'number') return -1;
            if (typeof r === 'number') return 1;
            return String(l).localeCompare(String(r));
        }
        return left.localeCompare(right);
    }

    function tintCanvas(canvas, color, keepShading = true) {
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;

        for (let i = 0; i < pixels.length; i += 4) {
            const alpha = pixels[i + 3];
            if (!alpha) continue;

            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const brightness = (r + g + b) / 3;

            if (brightness < 52) {
                continue;
            }

            const shade = keepShading
                ? Math.max(0.35, Math.min(1, brightness / 255))
                : 1;

            pixels[i] = Math.round(color.r * shade);
            pixels[i + 1] = Math.round(color.g * shade);
            pixels[i + 2] = Math.round(color.b * shade);
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    function makeFallbackCanvas(label = '?') {
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.font = 'bold 42px sans-serif';
        ctx.textAlign = 'center';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, canvas.width / 2, canvas.height / 2);
        return canvas;
    }

    async function renderIcon({ type = 'cube', id = 1, color1 = 12, color2 = 3, glow = -1 } = {}, options = {}) {
        const category = getCategory(type);
        const iconNum = Math.max(1, parseInt(id, 10) || 1);
        const numStr = String(iconNum).padStart(2, '0');
        const baseName = `${category.prefix}_${numStr}`;
        const assetQuality = options.quality === 'uhd' ? 'uhd' : 'hd';
        const assetName = `${baseName}-${assetQuality}`;
        const iconPath = `/assets/icons/${category.folder}/${assetName}`;

        const [mainColor, secondColor, glowColor] = await Promise.all([
            getColor(color1, { r: 0, g: 230, b: 118 }),
            getColor(color2, { r: 255, g: 255, b: 255 }),
            getColor(glow, { r: 255, g: 255, b: 255 }),
        ]);

        let frames;
        try {
            const resp = await fetch(`${iconPath}.plist`);
            if (!resp.ok) return makeFallbackCanvas(String(iconNum));
            frames = parsePlistFrames(await resp.text());
        } catch (err) {
            return makeFallbackCanvas(String(iconNum));
        }

        const texture = await new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = getAssetUrl(`${iconPath}.png`);
        });
        if (!texture) return makeFallbackCanvas(String(iconNum));

        const frameKeys = Object.keys(frames);
        const renderPrefix = getAtlasRenderPrefix(frameKeys, baseName);
        if (!renderPrefix) return makeFallbackCanvas(String(iconNum));
        const baseLen = renderPrefix.length + 1;

        const glowLayerKeys = frameKeys
            .filter(key => key.startsWith(`${renderPrefix}_`) && key.endsWith('_001.png') && key.includes('_glow_'))
            .sort(compareAtlasLayers);

        const layerKeys = frameKeys
            .filter(key => key.startsWith(`${renderPrefix}_`) && key.endsWith('_001.png') && !key.includes('_glow_'))
            .sort(compareAtlasLayers)
            .sort((left, right) => {
                const leftPart = left.slice(baseLen, -'_001.png'.length);
                const rightPart = right.slice(baseLen, -'_001.png'.length);
                const leftIsBody = leftPart === '001';
                const rightIsBody = rightPart === '001';
                const leftIsSecond = /(?:^|_)0*2$/.test(leftPart);
                const rightIsSecond = /(?:^|_)0*2$/.test(rightPart);
                if (leftIsSecond !== rightIsSecond) return leftIsSecond ? -1 : 1;
                if (leftIsBody !== rightIsBody) return leftIsBody ? 1 : -1;
                return 0;
            });

        if (!layerKeys.length) return makeFallbackCanvas(String(iconNum));

        if (category.key === 'robot' || category.key === 'spider') {
            const animDescFilename = category.key === 'robot' ? 'Robot_AnimDesc.plist' : 'Spider_AnimDesc.plist';
            const animDescUrl = getAssetUrl(`/assets/icons/${animDescFilename}`);

            if (animDescCache[animDescUrl] === undefined) {
                try {
                    const ar = await fetch(animDescUrl);
                    animDescCache[animDescUrl] = ar.ok ? parsePlistFrames(await ar.text()) : null;
                } catch (err) {
                    animDescCache[animDescUrl] = null;
                }
            }

            const animDesc = animDescCache[animDescUrl];

            const idleKey = category.key === 'robot' ? 'Robot_idle_001.png' : 'Spider_idle_001.png';
            const idleFrame = animDesc && animDesc.animationContainer && animDesc.animationContainer[idleKey];

            if (idleFrame) {
                const SCALE = assetQuality === 'uhd' ? 4 : 2;
                const prefix01 = `${category.prefix}_01_`;

                function actualTex(name) {
                    return String(name || '').replace(prefix01, `${renderPrefix}_`);
                }

                const spriteList = Object.values(idleFrame)
                    .filter(sprite => sprite && sprite.texture)
                    .sort((a, b) => (parseInt(a.zValue, 10) || 0) - (parseInt(b.zValue, 10) || 0));

                let minX = 0;
                let minY = 0;
                let maxX = 1;
                let maxY = 1;

                function getSpriteTransform(sprite) {
                    const [px = 0, py = 0] = parseGDCoord(sprite.position);
                    const [sxRaw = 1, syRaw = 1] = parseGDCoord(sprite.scale);
                    const [flipXRaw = 0, flipYRaw = 0] = parseGDCoord(sprite.flipped);
                    const sx = Number.isFinite(sxRaw) ? sxRaw : 1;
                    const sy = Number.isFinite(syRaw) ? syRaw : 1;
                    const rot = (parseFloat(sprite.rotation) || 0) * Math.PI / 180;
                    const flipX = flipXRaw ? -1 : 1;
                    const flipY = flipYRaw ? -1 : 1;
                    return { px, py, sx, sy, rot, flipX, flipY };
                }

                for (const sprite of spriteList) {
                    const frame = normalizeAtlasFrame(frames[actualTex(sprite.texture)]);
                    if (!frame) continue;

                    const [, , rw = 0, rh = 0] = parseGDCoord(frame.textureRect);
                    const [ox = 0, oy = 0] = parseGDCoord(frame.spriteOffset);
                    const { px, py, sx, sy, rot, flipX, flipY } = getSpriteTransform(sprite);
                    const cosR = Math.cos(rot);
                    const sinR = Math.sin(rot);

                    for (const [cornerX, cornerY] of [
                        [ox - rw / 2, -oy - rh / 2],
                        [ox + rw / 2, -oy - rh / 2],
                        [ox - rw / 2, -oy + rh / 2],
                        [ox + rw / 2, -oy + rh / 2],
                    ]) {
                        const scx = cornerX * sx * flipX;
                        const scy = cornerY * sy * flipY;
                        const wx = px * SCALE + scx * cosR - scy * sinR;
                        const wy = -py * SCALE + scx * sinR + scy * cosR;
                        if (wx < minX) minX = wx;
                        if (wx > maxX) maxX = wx;
                        if (wy < minY) minY = wy;
                        if (wy > maxY) maxY = wy;
                    }
                }

                const renderScale = 2;
                const logicalW = Math.max(1, Math.ceil(maxX - minX));
                const logicalH = Math.max(1, Math.ceil(maxY - minY));
                const canvas = document.createElement('canvas');
                canvas.width = logicalW * renderScale;
                canvas.height = logicalH * renderScale;
                canvas.style.width = `${logicalW}px`;
                canvas.style.height = `${logicalH}px`;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.scale(renderScale, renderScale);

                function drawTex(texName, sprite, tintColor) {
                    const frame = normalizeAtlasFrame(frames[texName]);
                    if (!frame) return;

                    const [rx, ry, rw, rh] = parseGDCoord(frame.textureRect);
                    const [ox = 0, oy = 0] = parseGDCoord(frame.spriteOffset);
                    const rotated = frame.textureRotated === true;

                    const tmp = document.createElement('canvas');
                    tmp.width = rw;
                    tmp.height = rh;
                    const tctx = tmp.getContext('2d');
                    tctx.imageSmoothingEnabled = true;
                    tctx.imageSmoothingQuality = 'high';

                    if (rotated) {
                        tctx.save();
                        tctx.translate(rw / 2, rh / 2);
                        tctx.rotate(-Math.PI / 2);
                        tctx.drawImage(texture, rx, ry, rh, rw, -rh / 2, -rw / 2, rh, rw);
                        tctx.restore();
                    } else {
                        tctx.drawImage(texture, rx, ry, rw, rh, 0, 0, rw, rh);
                    }

                    if (tintColor) {
                        tintCanvas(tmp, tintColor, true);
                    }

                    const { px, py, sx, sy, rot, flipX, flipY } = getSpriteTransform(sprite);
                    ctx.save();
                    ctx.translate(-minX + px * SCALE, -minY - py * SCALE);
                    ctx.rotate(rot);
                    ctx.scale(sx * flipX, sy * flipY);
                    ctx.drawImage(tmp, 0, 0, rw, rh, ox - rw / 2, -oy - rh / 2, rw, rh);
                    ctx.restore();
                }

                if (Number(glow) >= 0) {
                    for (const sprite of spriteList) {
                        const mainName = actualTex(sprite.texture);
                        drawTex(mainName.replace('_001.png', '_glow_001.png'), sprite, glowColor);
                    }
                }

                for (const sprite of spriteList) {
                    const mainName = actualTex(sprite.texture);
                    drawTex(mainName.replace('_001.png', '_2_001.png'), sprite, secondColor);
                }

                for (const sprite of spriteList) {
                    const mainName = actualTex(sprite.texture);
                    drawTex(mainName, sprite, mainColor);
                }

                for (const sprite of spriteList) {
                    const mainName = actualTex(sprite.texture);
                    drawTex(mainName.replace('_001.png', '_extra_001.png'), sprite, null);
                }

                return canvas;
            }
        }

        let canvW = 1;
        let canvH = 1;
        for (const key of [...layerKeys, ...(Number(glow) >= 0 ? glowLayerKeys : [])]) {
            const frame = normalizeAtlasFrame(frames[key]);
            if (!frame) continue;
            const [ssw, ssh] = parseGDCoord(frame.spriteSourceSize);
            if (ssw > canvW) canvW = ssw;
            if (ssh > canvH) canvH = ssh;
        }

        const renderScale = 2;
        const logicalW = Math.max(1, Math.ceil(canvW));
        const logicalH = Math.max(1, Math.ceil(canvH));
        const canvas = document.createElement('canvas');
        canvas.width = logicalW * renderScale;
        canvas.height = logicalH * renderScale;
        canvas.style.width = `${logicalW}px`;
        canvas.style.height = `${logicalH}px`;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.scale(renderScale, renderScale);

        function drawAtlasLayer(key, tintColor = null) {
            const frame = normalizeAtlasFrame(frames[key]);
            if (!frame) return;

            const [rx, ry, rw, rh] = parseGDCoord(frame.textureRect);
            const [ox = 0, oy = 0] = parseGDCoord(frame.spriteOffset);
            const rotated = frame.textureRotated === true;
            const tmp = document.createElement('canvas');
            tmp.width = rw;
            tmp.height = rh;
            const tctx = tmp.getContext('2d');
            tctx.imageSmoothingEnabled = true;
            tctx.imageSmoothingQuality = 'high';

            if (rotated) {
                tctx.save();
                tctx.translate(rw / 2, rh / 2);
                tctx.rotate(-Math.PI / 2);
                tctx.drawImage(texture, rx, ry, rh, rw, -rh / 2, -rw / 2, rh, rw);
                tctx.restore();
            } else {
                tctx.drawImage(texture, rx, ry, rw, rh, 0, 0, rw, rh);
            }

            if (tintColor) {
                tintCanvas(tmp, tintColor, true);
            }

            const ufoYOffset = category.key === 'ufo' ? 10 : 0;
            const dx = logicalW / 2 + ox - rw / 2;
            const dy = logicalH / 2 - oy - rh / 2 + ufoYOffset;
            ctx.drawImage(tmp, 0, 0, rw, rh, dx, dy, rw, rh);
        }

        if (Number(glow) >= 0) {
            for (const key of glowLayerKeys) {
                drawAtlasLayer(key, glowColor);
            }
        }

        for (const key of layerKeys) {
            const part = key.slice(baseLen, -'_001.png'.length);
            const isSecondary = /(?:^|_)0*2$/.test(part);
            const isExtra = /extra/.test(part);
            drawAtlasLayer(key, isExtra ? null : (isSecondary ? secondColor : mainColor));
        }

        return canvas;
    }

    async function renderInto(host, icon, options = {}) {
        if (!host) return;
        host.textContent = '';
        host.classList.add('is-loading');
        const rendered = await renderIcon(icon, options);
        rendered.className = 'gd-icon-canvas';
        rendered.style.imageRendering = 'auto';
        host.classList.remove('is-loading');
        host.replaceChildren(rendered);
    }

    return { getCategories, loadColors, renderIcon, renderInto };
})();
