const { randomBytes } = require('crypto');
const rateLimit = require('express-rate-limit');

const API = 'https://discord.com/api/v10';

const syncLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many sync requests, slow down.' },
});

const ROLE_TIERS = [
    { max: 1, roleId: '1517234399739908147' },
    { max: 2, roleId: '1523382884247797780' },
    { max: 3, roleId: '1523382966254833816' },
    { max: 10, roleId: '1523383071368544407' },
    { max: 25, roleId: '1523383210841735228' },
    { max: 100, roleId: '1523383258044305438' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function registerDiscord(app, pool) {
    const cfg = () => ({
        clientId: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        botToken: process.env.DISCORD_BOT_TOKEN,
        guildId: process.env.DISCORD_GUILD_ID,
        redirectUri: process.env.DISCORD_REDIRECT_URI,
        syncSecret: process.env.DISCORD_SYNC_SECRET || process.env.CRON_SECRET,
    });

    const isConfigured = () => {
        const c = cfg();
        return c.clientId && c.clientSecret && c.botToken && c.guildId && c.redirectUri;
    };

    const managedRoleIds = () =>
        ROLE_TIERS.map((t) => t.roleId).filter(Boolean);

    const roleForRank = (rank) => {
        if (!rank || rank < 1) return null;
        for (const tier of ROLE_TIERS) {
            if (rank <= tier.max) return tier.roleId || null;
        }
        return null;
    };

    async function discordFetch(url, options = {}, retries = 4) {
        const res = await fetch(url, options);
        if (res.status === 429 && retries > 0) {
            let wait = 1000;
            try {
                const body = await res.clone().json();
                if (body && body.retry_after) wait = body.retry_after * 1000;
            } catch (_) {}
            await sleep(wait + 150);
            return discordFetch(url, options, retries - 1);
        }
        return res;
    }

    const botHeaders = () => ({
        Authorization: `Bot ${cfg().botToken}`,
        'Content-Type': 'application/json',
        'X-Audit-Log-Reason': 'WBDL leaderboard role sync',
    });

    async function reconcileMember(discordId, desiredRoleId) {
        const { guildId } = cfg();
        const managed = managedRoleIds();

        const memberRes = await discordFetch(
            `${API}/guilds/${guildId}/members/${discordId}`,
            { headers: botHeaders() }
        );
        if (memberRes.status === 404) return 'not_in_guild';
        if (!memberRes.ok) return `member_fetch_${memberRes.status}`;

        const member = await memberRes.json();
        const current = new Set(member.roles || []);

        for (const rid of managed) {
            if (rid === desiredRoleId) continue;
            if (current.has(rid)) {
                await discordFetch(
                    `${API}/guilds/${guildId}/members/${discordId}/roles/${rid}`,
                    { method: 'DELETE', headers: botHeaders() }
                );
            }
        }
        if (desiredRoleId && !current.has(desiredRoleId)) {
            await discordFetch(
                `${API}/guilds/${guildId}/members/${discordId}/roles/${desiredRoleId}`,
                { method: 'PUT', headers: botHeaders() }
            );
        }
        return 'ok';
    }

    async function computeLinkedRanks() {
        const query = `
            WITH PlayerStats AS (
                SELECT
                    u.discord_id,
                    SUM(
                        CASE
                            WHEN d.position > 150 THEN 0
                            WHEN r.percentage = 100
                                THEN (250 * EXP(-0.0263 * (d.position - 1)))
                            WHEN d.position <= 75 AND r.percentage >= d.requirement
                                THEN (250 * EXP(-0.0263 * (d.position - 1))) / 10
                            ELSE 0
                        END
                    ) as total_points
                FROM users u
                JOIN records r ON u.id = r.user_id
                JOIN demons d ON r.demon_id = d.id
                WHERE r.status = 'accepted' AND r.list_type = 'primary' AND d.list_type = 'primary'
                GROUP BY u.id, u.discord_id
            ),
            Ranked AS (
                SELECT *, RANK() OVER (ORDER BY total_points DESC) as rank
                FROM PlayerStats
            )
            SELECT discord_id, rank FROM Ranked WHERE discord_id IS NOT NULL;
        `;
        const { rows } = await pool.query(query);
        const map = new Map();
        for (const row of rows) map.set(row.discord_id, parseInt(row.rank));
        return map;
    }

    async function syncRoles(onlyDiscordId = null) {
        if (!isConfigured()) throw new Error('Discord integration is not configured.');

        const rankMap = await computeLinkedRanks();

        let linked;
        if (onlyDiscordId) {
            linked = [{ discord_id: onlyDiscordId }];
        } else {
            const { rows } = await pool.query(
                'SELECT discord_id FROM users WHERE discord_id IS NOT NULL'
            );
            linked = rows;
        }

        const summary = { total: linked.length, updated: 0, skipped: 0, errors: 0 };
        for (const u of linked) {
            const desired = roleForRank(rankMap.get(u.discord_id) || null);
            try {
                const status = await reconcileMember(u.discord_id, desired);
                if (status === 'ok') summary.updated++;
                else if (status === 'not_in_guild') summary.skipped++;
                else summary.errors++;
            } catch (err) {
                console.error('Discord sync error for', u.discord_id, err);
                summary.errors++;
            }
            await sleep(250);
        }
        return summary;
    }

    async function clearRoles(discordId) {
        if (!isConfigured()) return;
        try {
            await reconcileMember(discordId, null);
        } catch (err) {
            console.error('Discord clearRoles error for', discordId, err);
        }
    }

    app.get('/api/discord/link', (req, res) => {
        if (!req.session.userId) return res.redirect('/login.html');
        if (!isConfigured()) return res.status(503).send('Discord integration is not configured.');

        const state = randomBytes(16).toString('hex');
        req.session.discordOAuthState = state;

        const c = cfg();
        const params = new URLSearchParams({
            client_id: c.clientId,
            redirect_uri: c.redirectUri,
            response_type: 'code',
            scope: 'identify guilds.join',
            state,
            prompt: 'consent',
        });
        res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    });

    app.get('/api/discord/callback', async (req, res) => {
        const { code, state } = req.query;
        if (!req.session.userId) return res.redirect('/login.html');
        if (!code || !state || state !== req.session.discordOAuthState) {
            return res.redirect('/settings.html?discord=error');
        }
        req.session.discordOAuthState = null;
        if (!isConfigured()) return res.redirect('/settings.html?discord=error');

        const c = cfg();
        try {
            const tokenRes = await fetch(`${API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: c.clientId,
                    client_secret: c.clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: c.redirectUri,
                }),
            });
            if (!tokenRes.ok) return res.redirect('/settings.html?discord=error');
            const token = await tokenRes.json();

            const userRes = await fetch(`${API}/users/@me`, {
                headers: { Authorization: `Bearer ${token.access_token}` },
            });
            if (!userRes.ok) return res.redirect('/settings.html?discord=error');
            const dUser = await userRes.json();

            const existing = await pool.query(
                'SELECT id FROM users WHERE discord_id = $1 AND id <> $2',
                [dUser.id, req.session.userId]
            );
            if (existing.rows.length > 0) {
                return res.redirect('/settings.html?discord=taken');
            }

            await pool.query(
                'UPDATE users SET discord_id = $1, discord_username = $2, social_discord = $2 WHERE id = $3',
                [dUser.id, dUser.username, req.session.userId]
            );

            await fetch(`${API}/guilds/${c.guildId}/members/${dUser.id}`, {
                method: 'PUT',
                headers: botHeaders(),
                body: JSON.stringify({ access_token: token.access_token }),
            }).catch(() => {});

            syncRoles(dUser.id).catch((e) => console.error('post-link sync', e));

            res.redirect('/settings.html?discord=linked');
        } catch (err) {
            console.error('Discord callback error:', err);
            res.redirect('/settings.html?discord=error');
        }
    });

    app.get('/api/discord/status', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        try {
            const { rows } = await pool.query(
                'SELECT discord_id, discord_username FROM users WHERE id = $1',
                [req.session.userId]
            );
            const row = rows[0] || {};
            res.json({
                configured: isConfigured(),
                linked: !!row.discord_id,
                username: row.discord_username || null,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Database error' });
        }
    });

    app.post('/api/discord/unlink', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        try {
            const { rows } = await pool.query(
                'SELECT discord_id FROM users WHERE id = $1',
                [req.session.userId]
            );
            const discordId = rows[0] && rows[0].discord_id;
            await pool.query(
                'UPDATE users SET discord_id = NULL, discord_username = NULL, social_discord = NULL WHERE id = $1',
                [req.session.userId]
            );
            if (discordId) clearRoles(discordId).catch(() => {});
            res.json({ message: 'Unlinked' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Database error' });
        }
    });

    const syncHandler = async (req, res) => {
        const c = cfg();
        if (!c.syncSecret) return res.status(503).json({ error: 'Sync secret not configured.' });

        const auth = req.headers.authorization || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.secret;
        if (provided !== c.syncSecret) return res.status(401).json({ error: 'Unauthorized' });

        try {
            const summary = await syncRoles();
            res.json({ ok: true, ...summary });
        } catch (err) {
            console.error('Discord sync failed:', err);
            res.status(500).json({ error: 'Sync failed' });
        }
    };
    app.get('/api/discord/sync', syncLimiter, syncHandler);
    app.post('/api/discord/sync', syncLimiter, syncHandler);
};
