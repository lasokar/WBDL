const { randomBytes } = require('crypto');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const API = 'https://discord.com/api/v10';
const BADGE_CONFIG_PATH = path.join(__dirname, 'badges.json');

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

    function loadCommunityBadge() {
        try {
            const parsed = JSON.parse(fs.readFileSync(BADGE_CONFIG_PATH, 'utf8'));
            const group = (Array.isArray(parsed.groups) ? parsed.groups : [])
                .find(item => String(item?.id || '') === 'community-member');
            const tier = (Array.isArray(group?.tiers) ? group.tiers : [])
                .find(item => Number(item?.id) === 1);

            if (group?.requirement?.type !== 'discord_guild_member' || !tier) {
                return null;
            }

            return { group, tier };
        } catch (err) {
            console.error('Community badge config load error:', err);
            return null;
        }
    }

    async function grantCommunityBadge(userId) {
        const configured = loadCommunityBadge();
        if (!configured || !Number.isInteger(Number(userId))) return false;

        const { group, tier } = configured;
        const tierId = Number(tier.id);
        const badgeEntry = {
            groupId: String(group.id),
            tierId,
            listType: 'global',
            unlockedAt: new Date().toISOString(),
            metadata: {
                discordGuildMember: true,
            },
        };

        const inserted = await pool.query(`
            UPDATE users
            SET badges = COALESCE(badges, '[]'::jsonb) || $2::jsonb
            WHERE id = $1
              AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(badges, '[]'::jsonb)) AS stored(entry)
                  WHERE stored.entry->>'groupId' = $3
                    AND stored.entry->>'tierId' = $4
                    AND COALESCE(stored.entry->>'listType', 'primary') = 'global'
              )
            RETURNING id
        `, [
            Number(userId),
            JSON.stringify([badgeEntry]),
            String(group.id),
            String(tierId),
        ]);

        if (!inserted.rows.length) return false;

        await pool.query(`
            INSERT INTO notifications
                (user_id, actor_id, record_id, type, reason, list_type, subject, body, sender_name, is_read)
            VALUES ($1, NULL, NULL, 'badge_unlocked', NULL, 'primary', $2, $3, 'WBDL', FALSE)
        `, [
            Number(userId),
            'New Badge Unlocked!',
            `You unlocked **${tier.name || 'Community Member'}**.\n\n${tier.description || ''}`,
        ]);

        return true;
    }

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
        for (const row of rows) map.set(String(row.discord_id), parseInt(row.rank, 10));
        return map;
    }

    async function syncRoles(onlyDiscordId = null) {
        if (!isConfigured()) throw new Error('Discord integration is not configured.');

        const rankMap = await computeLinkedRanks();

        let linked;
        if (onlyDiscordId) {
            const { rows } = await pool.query(
                'SELECT id, discord_id FROM users WHERE discord_id = $1::varchar',
                [String(onlyDiscordId)]
            );
            linked = rows;
        } else {
            const { rows } = await pool.query(
                'SELECT id, discord_id FROM users WHERE discord_id IS NOT NULL'
            );
            linked = rows;
        }

        const summary = { total: linked.length, updated: 0, skipped: 0, errors: 0 };
        for (const u of linked) {
            const discordId = String(u.discord_id);
            const desired = roleForRank(rankMap.get(discordId) || null);
            try {
                const status = await reconcileMember(discordId, desired);
                if (status === 'ok') {
                    summary.updated++;
                    await grantCommunityBadge(Number(u.id));
                }
                else if (status === 'not_in_guild') summary.skipped++;
                else summary.errors++;
            } catch (err) {
                console.error('Discord sync error for', discordId, err);
                summary.errors++;
            }
            await sleep(250);
        }
        return summary;
    }

    async function clearRoles(discordId) {
        if (!isConfigured()) return;
        try {
            await reconcileMember(String(discordId), null);
        } catch (err) {
            console.error('Discord clearRoles error for', discordId, err);
        }
    }

    function escapeDiscordText(value) {
        return String(value ?? '').replace(/([\`*_{}\[\]()#+\-.!|>~])/g, '\$1');
    }

    async function sendDirectMessage(discordId, content) {
        const c = cfg();
        if (!c.botToken) throw new Error('Discord bot token is not configured.');

        const dmResponse = await discordFetch(`${API}/users/@me/channels`, {
            method: 'POST',
            headers: botHeaders(),
            body: JSON.stringify({ recipient_id: String(discordId) }),
        });
        if (!dmResponse.ok) {
            throw new Error(`Could not open Discord DM channel (${dmResponse.status}).`);
        }

        const channel = await dmResponse.json();
        const messageResponse = await discordFetch(`${API}/channels/${channel.id}/messages`, {
            method: 'POST',
            headers: botHeaders(),
            body: JSON.stringify({
                content: String(content).slice(0, 2000),
                allowed_mentions: { users: [String(discordId)] },
            }),
        });
        if (!messageResponse.ok) {
            throw new Error(`Could not send Discord DM (${messageResponse.status}).`);
        }
    }

    app.locals.sendDiscordSubmissionNotification = async ({
        discordIds = [],
        submitterName,
        demonName,
        position,
        percentage,
        videoUrl,
        enjoymentRating = null,
        isUpdate = false,
    }) => {
        if (!cfg().botToken) {
            console.warn('Discord submission notification skipped: bot token is not configured.');
            return;
        }

        const uniqueDiscordIds = [...new Set(discordIds.map(String).filter(Boolean))];
        const title = isUpdate ? 'Updated WBDL record submission' : 'New WBDL record submission';
        const placement = Number.isFinite(Number(position)) ? ` (#${Number(position)})` : '';
        const enjoymentLine = enjoymentRating == null ? '' : `
**Enjoyment:** ${Number(enjoymentRating)}/10`;

        for (const discordId of uniqueDiscordIds) {
            const content = `<@${discordId}> **${title}**
**Player:** ${escapeDiscordText(submitterName)}
**Level:** ${escapeDiscordText(demonName)}${placement}
**Progress:** ${Number(percentage)}%${enjoymentLine}
**Video:** ${videoUrl}`;
            try {
                await sendDirectMessage(discordId, content);
            } catch (err) {
                console.error(`Discord submission DM failed for ${discordId}:`, err.message);
            }
            await sleep(150);
        }
    };

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
            scope: 'identify',
            state,
            prompt: 'consent',
        });
        res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    });

    app.get('/api/discord/callback', async (req, res) => {
        const { code, state } = req.query;
        if (!req.session.userId) return res.redirect('/login.html');
        if (!code || !state || state !== req.session.discordOAuthState) {
            return res.redirect('/account-settings?discord=error');
        }
        req.session.discordOAuthState = null;
        if (!isConfigured()) return res.redirect('/account-settings?discord=error');

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
            if (!tokenRes.ok) return res.redirect('/account-settings?discord=error');
            const token = await tokenRes.json();

            const userRes = await fetch(`${API}/users/@me`, {
                headers: { Authorization: `Bearer ${token.access_token}` },
            });
            if (!userRes.ok) return res.redirect('/account-settings?discord=error');
            const dUser = await userRes.json();

            const userId = Number.parseInt(req.session.userId, 10);
            const discordId = String(dUser.id || '');
            const discordUsername = String(dUser.username || '');

            if (!Number.isInteger(userId) || !discordId) {
                return res.redirect('/account-settings?discord=error');
            }

            const existing = await pool.query(
                `
                SELECT id
                FROM users
                WHERE discord_id = $1::varchar
                  AND id <> $2::integer
                `,
                [discordId, userId]
            );
            if (existing.rows.length > 0) {
                return res.redirect('/account-settings?discord=taken');
            }

            await pool.query(
                `
                UPDATE users
                SET discord_id = $1::varchar,
                    discord_username = $2::varchar,
                    social_discord = $2::varchar
                WHERE id = $3::integer
                `,
                [discordId, discordUsername, userId]
            );

            try {
                await syncRoles(discordId);
            } catch (syncErr) {
                console.error('post-link sync', syncErr);
            }

            res.redirect('/account-settings?discord=linked');
        } catch (err) {
            console.error('Discord callback error:', err);
            res.redirect('/account-settings?discord=error');
        }
    });

    app.get('/api/discord/status', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
        try {
            const userId = Number.parseInt(req.session.userId, 10);
            if (!Number.isInteger(userId)) return res.status(401).json({ error: 'Unauthorized' });

            const { rows } = await pool.query(
                'SELECT discord_id, discord_username FROM users WHERE id = $1::integer',
                [userId]
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
            const userId = Number.parseInt(req.session.userId, 10);
            if (!Number.isInteger(userId)) return res.status(401).json({ error: 'Unauthorized' });

            const { rows } = await pool.query(
                'SELECT discord_id FROM users WHERE id = $1::integer',
                [userId]
            );
            const discordId = rows[0] && rows[0].discord_id;
            await pool.query(
                `UPDATE users
                 SET discord_id = NULL,
                     discord_username = NULL,
                     social_discord = NULL,
                     submission_discord_ping = FALSE
                 WHERE id = $1::integer`,
                [userId]
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
