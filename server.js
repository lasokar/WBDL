const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { randomBytes } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();
const app = express();
app.use(cors({
    origin: ['https://webdemonlist.org', 'https://impossible.webdemonlist.org'],
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (host.startsWith('impossible.')) {
        req.currentList = 'impossible';
    } else {
        req.currentList = 'main';
    }
    next();
});

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const validateUsername = (username) => {
    if (!username || username.length < 3 || username.length > 20) {
        return "Username must be between 3 and 20 characters long.";
    }
    const usernameRegex = /^[a-zA-Z0-9._-]+$/;
    if (!usernameRegex.test(username)) {
        return "Usernames can only contain letters, numbers, underscores, dashes, and periods.";
    }
    return null;
};

const validatePassword = (password) => {
    if (!password || password.length < 6) {
        return "Password must be at least 6 characters.";
    }
    return null;
};

const PROFILE_ICON_TYPES = new Set(['cube', 'ship', 'ball', 'ufo', 'wave', 'robot', 'spider', 'swing', 'jetpack']);

const cleanProfileText = (value, maxLength) => {
    const text = String(value ?? '').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
};

const readProfileInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};

const cleanProfileIcon = (icon = {}) => {
    const type = PROFILE_ICON_TYPES.has(icon.type) ? icon.type : 'cube';
    const parsedId = parseInt(icon.id, 10);
    const parsedColor1 = parseInt(icon.color1, 10);
    const parsedColor2 = parseInt(icon.color2, 10);
    const parsedGlow = parseInt(icon.glow, 10);

    const id = Number.isNaN(parsedId) ? 1 : Math.min(999, Math.max(1, parsedId));
    const color1 = Number.isNaN(parsedColor1) ? 12 : Math.min(999, Math.max(0, parsedColor1));
    const color2 = Number.isNaN(parsedColor2) ? 3 : Math.min(999, Math.max(0, parsedColor2));
    const glow = Number.isNaN(parsedGlow) ? -1 : Math.min(999, Math.max(-1, parsedGlow));

    return { type, id, color1, color2, glow };
};


function getLevelUpdateFromId(levelId) {
    const id = parseInt(levelId, 10);
    if (Number.isNaN(id)) return null;

    const ranges = [
        { version: '1.0', min: 128, max: 1941 },
        { version: '1.1', min: 1942, max: 10043 },
        { version: '1.2', min: 10049, max: 63415 },
        { version: '1.3', min: 63419, max: 121068 },
        { version: '1.4', min: 121074, max: 184425 },
        { version: '1.5', min: 184440, max: 420780 },
        { version: '1.6', min: 420781, max: 827308 },
        { version: '1.7', min: 827316, max: 1627362 },
        { version: '1.8', min: 1627371, max: 2810918 },
        { version: '1.9', min: 2810991, max: 11020426 },
        { version: '2.0', min: 11020438, max: 28356225 },
        { version: '2.1', min: 28356243, max: 97454397 },
        { version: '2.2', min: 97454398, max: Infinity },
    ];

    const match = ranges.find(range => id >= range.min && id <= range.max);
    return match ? match.version : null;
}

async function getEstimatedLevelUploadDate(levelId) {
    const id = parseInt(levelId, 10);
    if (Number.isNaN(id)) return null;

    try {
        const response = await axios.get(`https://history.geometrydash.eu/api/v1/date/level/${id}`, {
            timeout: 4500,
            validateStatus: status => status >= 200 && status < 500
        });

        if (response.status !== 200 || !response.data) return null;
        return response.data;
    } catch (err) {
        console.error(`GDHistory lookup failed for level ${id}:`, err.message);
        return null;
    }
}


function parseTimeMachineDate(value) {
    const raw = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

    const selected = new Date(`${raw}T23:59:59.999Z`);
    const now = new Date();

    if (Number.isNaN(selected.getTime()) || selected > now) return null;
    return selected;
}

function getDateInputValue(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

async function getTimeMachineMinDateValue(list) {
    const result = await pool.query(`
        SELECT MIN(created_at) AS first_created_at
        FROM changelog
        WHERE list_type = $1
          AND change_type IN ('added', 'moved', 'deleted')
    `, [list]);

    const firstCreatedAt = result.rows[0]?.first_created_at;
    if (!firstCreatedAt) return null;

    const minDate = new Date(firstCreatedAt);
    if (Number.isNaN(minDate.getTime())) return null;

    minDate.setUTCDate(minDate.getUTCDate() - 1);
    return getDateInputValue(minDate);
}

function isTimeMachineDateAllowed(selectedDate, minDateValue) {
    if (!selectedDate || !minDateValue) return false;

    const minDate = new Date(`${minDateValue}T00:00:00.000Z`);
    if (Number.isNaN(minDate.getTime())) return false;

    return selectedDate >= minDate;
}

function normalizeDemonSnapshotRows(rows = []) {
    return rows
        .map(row => ({
            ...row,
            id: row.id == null ? null : Number(row.id),
            position: Number(row.position),
            time_machine_deleted_placeholder: Boolean(row.time_machine_deleted_placeholder),
        }))
        .filter(row => Number.isFinite(row.position))
        .sort((a, b) => a.position - b.position);
}

function normalizeHistoricalPositions(rows = []) {
    return rows
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((row, index) => ({
            ...row,
            position: index + 1,
        }));
}

function removeHistoricalEntry(rows, demonId) {
    const id = Number(demonId);
    const index = rows.findIndex(row => Number(row.id) === id);
    if (index === -1) return null;
    const [removed] = rows.splice(index, 1);
    return removed;
}

function undoHistoricalAdd(rows, log) {
    const newPosition = Number(log.new_position);
    if (!Number.isFinite(newPosition)) return rows;

    const removed = removeHistoricalEntry(rows, log.demon_id);

    rows.forEach(row => {
        if (Number(row.position) > newPosition) {
            row.position = Number(row.position) - 1;
        }
    });

    if (!removed) {
        rows = normalizeHistoricalPositions(rows);
    }

    return rows;
}

function undoHistoricalDelete(rows, log) {
    const oldPosition = Number(log.old_position);
    if (!Number.isFinite(oldPosition)) return rows;

    rows.forEach(row => {
        if (Number(row.position) >= oldPosition) {
            row.position = Number(row.position) + 1;
        }
    });

    rows.push({
        id: null,
        name: log.demon_name || 'Deleted Level',
        author: 'Unknown',
        position: oldPosition,
        requirement: 0,
        level_id: null,
        showcase_url: null,
        showcase_link: null,
        records: [],
        list_type: log.list_type,
        time_machine_deleted_placeholder: true,
        time_machine_original_demon_id: log.demon_id,
    });

    return rows;
}

function undoHistoricalMove(rows, log) {
    const oldPosition = Number(log.old_position);
    const newPosition = Number(log.new_position);

    if (!Number.isFinite(oldPosition) || !Number.isFinite(newPosition)) return rows;

    const moved = removeHistoricalEntry(rows, log.demon_id) || {
        id: log.demon_id == null ? null : Number(log.demon_id),
        name: log.demon_name || 'Archived Level',
        author: 'Unknown',
        position: oldPosition,
        requirement: 0,
        level_id: null,
        showcase_url: null,
        showcase_link: null,
        records: [],
        list_type: log.list_type,
        time_machine_deleted_placeholder: true,
        time_machine_original_demon_id: log.demon_id,
    };

    if (newPosition < oldPosition) {
        rows.forEach(row => {
            if (Number(row.position) > newPosition && Number(row.position) <= oldPosition) {
                row.position = Number(row.position) - 1;
            }
        });
    } else if (newPosition > oldPosition) {
        rows.forEach(row => {
            if (Number(row.position) >= oldPosition && Number(row.position) < newPosition) {
                row.position = Number(row.position) + 1;
            }
        });
    }

    moved.position = oldPosition;
    rows.push(moved);

    return rows;
}


async function queryCurrentDemonSnapshotRows(list) {
    const result = await pool.query(`
        SELECT 
            d.*, 
            CASE 
                WHEN $1 = 'impossible' THEN d.showcase_url
                ELSE (
                    SELECT r.video_url 
                    FROM records r 
                    WHERE r.demon_id = d.id 
                      AND r.status = 'accepted' 
                      AND r.percentage = 100
                    ORDER BY r.id ASC 
                    LIMIT 1
                )
            END AS showcase_link,
            COALESCE(
                (
                    SELECT json_agg(json_build_object('percentage', r.percentage))
                    FROM records r
                    WHERE r.demon_id = d.id AND r.status = 'accepted'
                ),
                '[]'::json
            ) AS records
        FROM demons d 
        WHERE d.list_type = $1
        ORDER BY d.position ASC
    `, [list]);

    return result.rows;
}

async function buildHistoricalDemonSnapshot(currentRows, list, targetDate) {
    let rows = normalizeDemonSnapshotRows(currentRows);

    const changelogResult = await pool.query(`
        SELECT demon_id, demon_name, change_type, old_position, new_position, created_at, list_type
        FROM changelog
        WHERE list_type = $1
          AND created_at > $2
          AND change_type IN ('added', 'moved', 'deleted')
        ORDER BY created_at DESC, id DESC
    `, [list, targetDate]);

    for (const log of changelogResult.rows) {
        if (log.change_type === 'added') {
            rows = undoHistoricalAdd(rows, log);
        } else if (log.change_type === 'deleted') {
            rows = undoHistoricalDelete(rows, log);
        } else if (log.change_type === 'moved') {
            rows = undoHistoricalMove(rows, log);
        }

        rows = normalizeHistoricalPositions(rows);
    }

    return normalizeHistoricalPositions(rows).map(row => ({
        ...row,
        time_machine_snapshot: true,
    }));
}


const serializeProfileUser = (user) => ({
    displayName: user.display_name || '',
    bio: user.bio || '',
    pronouns: user.pronouns || '',
    country: user.country || '',
    discordUsername: user.discord_username || '',
    socialLinks: {
        youtube: user.social_youtube || '',
        twitter: user.social_twitter || '',
        twitch: user.social_twitch || '',
        discord: user.discord_username || '',
        reddit: user.social_reddit || '',
        gdbrowser: user.social_gdbrowser || '',
    },
    icon: {
        type: user.icon_type || 'cube',
        id: readProfileInt(user.icon_id, 1),
        color1: readProfileInt(user.color1, 12),
        color2: readProfileInt(user.color2, 3),
        glow: readProfileInt(user.glow, -1),
    },
});


const STAFF_ROLES = new Set(['moderator', 'admin', 'owner']);
const ADMIN_ROLES = new Set(['admin', 'owner']);
const BADGE_CONFIG_PATH = path.join(__dirname, 'badges.json');

function isStaffRole(role) {
    return STAFF_ROLES.has(String(role || '').toLowerCase());
}

function canModerateTargetRole(actorRole, targetRole) {
    const actor = String(actorRole || '').toLowerCase();
    if (!isStaffRole(targetRole)) return true;
    return actor === 'owner';
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeEnjoymentRating(value, percentage) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = parseInt(value, 10);
    if (parseInt(percentage, 10) !== 100 || Number.isNaN(parsed) || parsed < 1 || parsed > 10) {
        return null;
    }
    return parsed;
}

function isValidHttpUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function loadBadgeConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(BADGE_CONFIG_PATH, 'utf8'));
        return Array.isArray(parsed.groups) ? parsed : { groups: [] };
    } catch (err) {
        console.error('Badge config load error:', err);
        return { groups: [] };
    }
}

function formatTrackedDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts = [];
    if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
    if (hours || days) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    if (minutes || hours || days) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    if (!parts.length) parts.push(`${secs} second${secs === 1 ? '' : 's'}`);
    return parts.slice(0, 3).join(', ');
}

async function createInboxNotification(db, {
    userId,
    actorId = null,
    recordId = null,
    type = 'message',
    reason = null,
    listType = 'primary',
    subject,
    body,
    senderName = null,
}) {
    if (!userId || !subject || !body) return null;
    return db.query(`
        INSERT INTO notifications
            (user_id, actor_id, record_id, type, reason, list_type, subject, body, sender_name, is_read)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)
        RETURNING id
    `, [userId, actorId, recordId, type, reason, listType, subject, body, senderName]);
}

async function getCurrentLeaderboardLeader(db, list) {
    const result = await db.query(`
        WITH PlayerStats AS (
            SELECT
                u.id,
                SUM(
                    CASE
                        WHEN d.position > 150 THEN 0
                        WHEN $1 = 'impossible' THEN
                            (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                        ELSE
                            CASE
                                WHEN r.percentage = 100 THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                WHEN d.position <= 75 AND r.percentage >= d.requirement THEN
                                    (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                ELSE 0
                            END
                    END
                ) AS total_points
            FROM users u
            JOIN records r ON u.id = r.user_id
            JOIN demons d ON r.demon_id = d.id
            WHERE r.status = 'accepted'
              AND r.list_type = $1
              AND d.list_type = $1
              AND COALESCE(u.leaderboard_banned, FALSE) = FALSE
              AND COALESCE(u.account_disabled, FALSE) = FALSE
            GROUP BY u.id
        )
        SELECT id
        FROM PlayerStats
        WHERE total_points > 0
        ORDER BY total_points DESC, id ASC
        LIMIT 1
    `, [list]);
    return result.rows[0]?.id || null;
}

async function syncLeaderboardTopOne(list, db = pool) {
    if (list === 'impossible') return { changedUserIds: [] };

    const currentLeaderId = await getCurrentLeaderboardLeader(db, list);
    const openResult = await db.query(`
        SELECT id, user_id
        FROM leaderboard_top1_periods
        WHERE list_type = $1 AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
    `, [list]);
    const open = openResult.rows[0] || null;

    if (String(open?.user_id || '') === String(currentLeaderId || '')) {
        return { changedUserIds: [] };
    }

    const changedUserIds = [];
    if (open) {
        changedUserIds.push(open.user_id);
        await db.query('UPDATE leaderboard_top1_periods SET ended_at = NOW() WHERE id = $1', [open.id]);
    }

    if (currentLeaderId) {
        changedUserIds.push(currentLeaderId);
        try {
            await db.query(`
                INSERT INTO leaderboard_top1_periods (user_id, list_type, started_at)
                VALUES ($1, $2, NOW())
            `, [currentLeaderId, list]);
        } catch (err) {
            if (err.code !== '23505') throw err;
        }
    }

    return { changedUserIds: [...new Set(changedUserIds.map(Number).filter(Boolean))] };
}

async function getBadgeMetrics(userId, list, db = pool) {
    const result = await db.query(`
        SELECT
            (
                SELECT created_at
                FROM users
                WHERE id = $1
            ) AS joined_at,
            (
                SELECT COUNT(DISTINCT r.demon_id)::int
                FROM records r
                JOIN demons d ON d.id = r.demon_id
                WHERE r.user_id = $1
                  AND r.status = 'accepted'
                  AND COALESCE(r.percentage, 0) = 100
                  AND r.list_type = $2
                  AND d.list_type = $2
                  AND d.position <= 150
            ) AS completed_levels,
            (
                SELECT COUNT(*)::int
                FROM verifications v
                WHERE v.user_id = $1
                  AND v.status = 'accepted'
                  AND v.list_type = $2
            ) AS verified_levels,
            (
                SELECT COUNT(DISTINCT r.demon_id)::int
                FROM records r
                JOIN demons d ON d.id = r.demon_id
                WHERE r.user_id = $1
                  AND r.status = 'accepted'
                  AND COALESCE(r.percentage, 0) = 100
                  AND r.list_type = $2
                  AND d.list_type = $2
                  AND (r.accepted_position <= 25 OR (r.accepted_position IS NULL AND d.position <= 25))
            ) AS completed_top_25,
            (
                SELECT COUNT(DISTINCT r.demon_id)::int
                FROM records r
                JOIN demons d ON d.id = r.demon_id
                WHERE r.user_id = $1
                  AND r.status = 'accepted'
                  AND COALESCE(r.percentage, 0) = 100
                  AND r.list_type = $2
                  AND d.list_type = $2
                  AND (r.accepted_position <= 10 OR (r.accepted_position IS NULL AND d.position <= 10))
            ) AS completed_top_10,
            (
                SELECT COUNT(DISTINCT r.demon_id)::int
                FROM records r
                JOIN demons d ON d.id = r.demon_id
                WHERE r.user_id = $1
                  AND r.status = 'accepted'
                  AND COALESCE(r.percentage, 0) = 100
                  AND r.list_type = $2
                  AND d.list_type = $2
                  AND (r.accepted_position = 1 OR (r.accepted_position IS NULL AND d.position = 1))
            ) AS completed_top_1,
            (
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(p.ended_at, NOW()) - p.started_at))), 0)::bigint
                FROM leaderboard_top1_periods p
                WHERE p.user_id = $1 AND p.list_type = $2
            ) AS top_1_duration_seconds
    `, [userId, list]);

    const row = result.rows[0] || {};
    return {
        joined_at: row.joined_at || null,
        completed_levels: Number(row.completed_levels) || 0,
        verified_levels: Number(row.verified_levels) || 0,
        completed_top_25: Number(row.completed_top_25) || 0,
        completed_top_10: Number(row.completed_top_10) || 0,
        completed_top_1: Number(row.completed_top_1) || 0,
        top_1_duration_seconds: Number(row.top_1_duration_seconds) || 0,
    };
}

const WBDL_RELEASE_AT = Date.parse('2026-04-07T00:00:00.000Z');
const WBDL_OG_WINDOW_END = Date.parse('2026-04-14T00:00:00.000Z');

function getBadgeMetricValue(metrics, requirement = {}) {
    if (requirement.type === 'joined_within_release_window') {
        if (!metrics.joined_at) return 0;

        const joinedAt = new Date(metrics.joined_at).getTime();
        if (Number.isNaN(joinedAt)) return 0;

        return joinedAt >= WBDL_RELEASE_AT && joinedAt < WBDL_OG_WINDOW_END ? 1 : 0;
    }

    if (requirement.type === 'top_level_completion') {
        if (Number(metrics.completed_top_1) > 0) return 3;
        if (Number(metrics.completed_top_10) > 0) return 2;
        if (Number(metrics.completed_top_25) > 0) return 1;
        return 0;
    }

    return Number(metrics[requirement.type]) || 0;
}

async function evaluateUserBadges(userId, list, db = pool) {
    if (list === 'impossible') return [];

    const config = loadBadgeConfig();
    const metrics = await getBadgeMetrics(userId, list, db);
    const userResult = await db.query(`
        SELECT COALESCE(badges, '[]'::jsonb) AS badges
        FROM users
        WHERE id = $1
    `, [userId]);

    if (!userResult.rows.length) return [];

    let storedBadges = Array.isArray(userResult.rows[0].badges)
        ? userResult.rows[0].badges
        : [];

    const legacyTopTierByGroup = new Map([
        ['top-25-completion', 1],
        ['top-10-completion', 2],
        ['top-one-completion', 3],
    ]);
    const legacyTopProgress = new Map();
    let hasLegacyTopBadges = false;

    for (const badge of storedBadges) {
        const legacyTier = legacyTopTierByGroup.get(String(badge?.groupId || ''));
        if (!legacyTier) continue;

        hasLegacyTopBadges = true;
        const listType = String(badge?.listType || 'primary');
        const current = legacyTopProgress.get(listType) || {
            highestTier: 0,
            unlockedAt: badge?.unlockedAt || badge?.unlocked_at || new Date().toISOString(),
        };

        current.highestTier = Math.max(current.highestTier, legacyTier);
        if (!current.unlockedAt) {
            current.unlockedAt = badge?.unlockedAt || badge?.unlocked_at || new Date().toISOString();
        }
        legacyTopProgress.set(listType, current);
    }

    if (hasLegacyTopBadges) {
        const normalizedBadges = storedBadges.filter(
            badge => !legacyTopTierByGroup.has(String(badge?.groupId || ''))
        );

        for (const [listType, legacy] of legacyTopProgress) {
            for (let tierId = 1; tierId <= legacy.highestTier; tierId += 1) {
                const alreadyStored = normalizedBadges.some(entry =>
                    String(entry?.groupId || '') === 'top-level-completion'
                    && Number(entry?.tierId) === tierId
                    && String(entry?.listType || 'primary') === listType
                );
                if (alreadyStored) continue;

                normalizedBadges.push({
                    groupId: 'top-level-completion',
                    tierId,
                    listType,
                    unlockedAt: legacy.unlockedAt,
                    metadata: { migratedFromLegacyTopBadge: true },
                });
            }
        }

        await db.query(
            'UPDATE users SET badges = $2::jsonb WHERE id = $1',
            [userId, JSON.stringify(normalizedBadges)]
        );
        storedBadges = normalizedBadges;
    }

    const existing = new Map();

    for (const badge of storedBadges) {
        const groupId = String(badge?.groupId || '');
        const tierId = Number(badge?.tierId);
        const listType = String(badge?.listType || 'primary');
        if (!groupId || !Number.isInteger(tierId)) continue;
        if (listType !== list && listType !== 'global') continue;
        existing.set(`${groupId}:${tierId}:${listType}`, badge);
    }

    for (const group of config.groups) {
        if (['manual', 'owner_only', 'discord_guild_member'].includes(group?.requirement?.type)) continue;

        const badgeListType = group?.scope === 'global' ? 'global' : list;
        const progress = getBadgeMetricValue(metrics, group.requirement);
        for (const tier of Array.isArray(group.tiers) ? group.tiers : []) {
            const tierId = Number(tier.id);
            if (!Number.isInteger(tierId) || progress < Number(tier.threshold || 0)) continue;

            const key = `${group.id}:${tierId}:${badgeListType}`;
            if (existing.has(key)) continue;

            const unlockedAt = new Date().toISOString();
            const badgeEntry = {
                groupId: group.id,
                tierId,
                listType: badgeListType,
                unlockedAt,
                metadata: { progressAtUnlock: progress },
            };

            const inserted = await db.query(`
                UPDATE users
                SET badges = COALESCE(badges, '[]'::jsonb) || $2::jsonb
                WHERE id = $1
                  AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(COALESCE(badges, '[]'::jsonb)) AS stored(entry)
                      WHERE stored.entry->>'groupId' = $3
                        AND stored.entry->>'tierId' = $4
                        AND COALESCE(stored.entry->>'listType', 'primary') = $5
                  )
                RETURNING badges
            `, [
                userId,
                JSON.stringify([badgeEntry]),
                group.id,
                String(tierId),
                badgeListType,
            ]);

            if (inserted.rows[0]) {
                existing.set(key, badgeEntry);
                await createInboxNotification(db, {
                    userId,
                    listType: list,
                    type: 'badge_unlocked',
                    senderName: 'WBDL',
                    subject: 'New Badge Unlocked!',
                    body: `You unlocked **${tier.name || `Badge ${tierId}`}**.\n\n${tier.description || ''}`,
                });
            } else {
                const refreshed = await db.query(`
                    SELECT COALESCE(badges, '[]'::jsonb) AS badges
                    FROM users
                    WHERE id = $1
                `, [userId]);
                const match = (Array.isArray(refreshed.rows[0]?.badges) ? refreshed.rows[0].badges : [])
                    .find(entry => String(entry?.groupId) === String(group.id)
                        && Number(entry?.tierId) === tierId
                        && String(entry?.listType || 'primary') === badgeListType);
                if (match) existing.set(key, match);
            }
        }
    }

    return config.groups.map(group => {
        const badgeListType = group?.scope === 'global' ? 'global' : list;
        const progressValue = getBadgeMetricValue(metrics, group.requirement);
        const tiers = (Array.isArray(group.tiers) ? group.tiers : [])
            .map(tier => {
                const tierId = Number(tier.id);
                const stored = existing.get(`${group.id}:${tierId}:${badgeListType}`);
                return {
                    ...tier,
                    id: tierId,
                    iconPath: tier.iconPath || group.iconPath || '/assets/icon.png',
                    unlocked: Boolean(stored),
                    unlockedAt: stored?.unlockedAt || stored?.unlocked_at || null,
                };
            })
            .filter(tier => Number.isInteger(tier.id));
        const unlockedTiers = tiers.filter(tier => tier.unlocked);
        const currentTier = unlockedTiers[unlockedTiers.length - 1] || null;
        const nextTier = tiers.find(tier => !tier.unlocked) || null;
        const isDuration = group.requirement?.type === 'top_1_duration_seconds';

        return {
            id: group.id,
            iconPath: currentTier?.iconPath || group.iconPath || '/assets/icon.png',
            requirement: group.requirement || {},
            unlocked: unlockedTiers.length > 0,
            currentTier,
            nextTier,
            tiers,
            progress: {
                value: progressValue,
                display: isDuration ? formatTrackedDuration(progressValue) : String(progressValue),
                nextThreshold: nextTier ? Number(nextTier.threshold || 0) : null,
                nextDisplay: nextTier
                    ? (isDuration ? formatTrackedDuration(nextTier.threshold) : String(nextTier.threshold))
                    : null,
            },
        };
    }).filter(group => group.unlocked);
}

app.get('/api/demons', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const timeMachineDate = parseTimeMachineDate(req.query.date || req.query.time_machine_date);

    try {
        const currentRows = await queryCurrentDemonSnapshotRows(list);

        if (timeMachineDate) {
            const minDateValue = await getTimeMachineMinDateValue(list);

            if (isTimeMachineDateAllowed(timeMachineDate, minDateValue)) {
                const historicalRows = await buildHistoricalDemonSnapshot(currentRows, list, timeMachineDate);
                return res.json(historicalRows);
            }
        }

        res.json(currentRows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});


app.get('/api/time-machine/min-date', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const minDate = await getTimeMachineMinDateValue(list);
        res.json({ min_date: minDate });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch time machine minimum date' });
    }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});
app.get('/demon/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'demon.html'));
});
app.get('/submit', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'submit.html'));
});
app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});
app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
});
app.get('/clans', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'clans.html'));
});
app.get('/clans/:clanName', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'clans.html'));
});
app.get('/account-settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});
app.get('/notifications', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'notifications.html'));
});
app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});
app.get('/changelog', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'changelog.html'));
});
app.get('/guidelines', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'guidelines.html'));
});
app.get('/staff', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'staff.html'));
});
app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});
app.get('/forgot-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});
app.get('/reset-password', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

const bcrypt = require('bcrypt');
const session = require('cookie-session');

const sessionConfig = {
  name: 'session',
  keys: [process.env.SESSION_SECRET],
  maxAge: 24 * 60 * 60 * 1000,
  sameSite: 'lax'
};

if (process.env.NODE_ENV === 'production') {
  sessionConfig.domain = '.webdemonlist.org';
}

app.use(session(sessionConfig));

app.use(async (req, res, next) => {
    if (!req.session?.userId || req.path === '/api/logout') return next();

    try {
        const result = await pool.query(
            'SELECT account_disabled, account_disabled_reason, role FROM users WHERE id = $1',
            [req.session.userId]
        );
        const user = result.rows[0];
        if (!user) {
            req.session = null;
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Session expired.', loggedIn: false });
            }
            return next();
        }

        if (user.account_disabled && !isStaffRole(user.role)) {
            const reason = user.account_disabled_reason || 'This account has been disabled by an administrator.';
            req.session = null;
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ error: reason, accountDisabled: true });
            }
            return res.redirect('/login?disabled=1');
        }

        next();
    } catch (err) {
        console.error('Account enforcement middleware error:', err);
        next(err);
    }
});

require('./discord')(app, pool);

async function sendVerificationEmail(targetEmail, username, link) {
    await resend.emails.send({
        from: 'Web Browser Demonlist <verify@webdemonlist.org>',
        to: targetEmail,
        subject: 'Verify your WBDL Account',
        html: `
        <div style="font-family: Comfortaa, Arial, sans-serif; background-color: #181b1e; color: #f2f3f5; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto; border: 1px solid #2a2f36;">
            <h1 style="font-family: Comfortaa, Arial, sans-serif; color: #00e676; text-align: center; margin: 0 0 22px; font-size: 28px; line-height: 1.2;">
                Welcome, ${username}!
            </h1>
            
            <p style="font-size: 16px; line-height: 1.6; text-align: center; color: #8b929c; margin: 0;">
                Thanks for signing up for the Web Browser Demonlist! To get started, activate your account by clicking the button below.
            </p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${link}" style="background-color: #00e676; color: #000; padding: 14px 28px; font-weight: 800; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 15px;">
                    Verify my Account
                </a>
            </div>

            <div style="background-color: #20242a; padding: 20px; border-radius: 8px; text-align: center; margin-top: 20px; border: 1px solid #2a2f36;">
                <p style="margin: 0 0 10px 0; color: #f2f3f5; font-size: 14px;">
                    Also, feel free to join the discord!
                </p>
                <a href="https://discord.gg/Pz8TehUPmP" style="color: #5865F2; text-decoration: none; font-weight: bold; font-size: 16px;">
                discord.gg/Pz8TehUPmP
                </a>
            </div>

            <hr style="border: 0; border-top: 1px solid #2a2f36; margin: 24px 0;">
            
            <p style="font-size: 12px; color: #5a616b; text-align: center; margin: 0;">
                If you didn't create an account, simply ignore this email.
            </p>
        </div>
        `
    });
}


async function sendEmailChangeVerification(targetEmail, username, link) {
    await resend.emails.send({
        from: 'Web Browser Demonlist <verify@webdemonlist.org>',
        to: targetEmail,
        subject: 'Verify your new WBDL email',
        html: `
        <div style="font-family: Comfortaa, Arial, sans-serif; background-color: #181b1e; color: #f2f3f5; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto; border: 1px solid #2a2f36;">
            <h1 style="color: #00e676; text-align: center; margin: 0 0 22px; font-size: 28px; line-height: 1.2;">
                Verify your new email
            </h1>

            <p style="font-size: 16px; line-height: 1.6; text-align: center; color: #8b929c; margin: 0;">
                Hello ${username}, click the button below to confirm this email address for your WBDL account.
            </p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${link}" style="background-color: #00e676; color: #000; padding: 14px 28px; font-weight: 800; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 15px;">
                    Verify new email
                </a>
            </div>

            <p style="font-size: 12px; color: #5a616b; text-align: center; margin: 0;">
                This link expires in 24 hours. Your current email will remain unchanged until this link is opened.
            </p>
        </div>
        `
    });
}

async function sendResetEmail(targetEmail, username, link) {
    await resend.emails.send({
        from: 'Web Browser Demonlist <support@webdemonlist.org>',
        to: targetEmail,
        subject: 'WBDL Password Reset',
        html: `
        <div style="font-family: Nunito, Arial, sans-serif; background-color: #181b1e; color: #f2f3f5; padding: 40px; border-radius: 12px; max-width: 600px; margin: auto; border: 1px solid #2a2f36;">
            <h1 style="font-family: Comfortaa, Arial, sans-serif; color: #00e676; text-align: center; margin: 0 0 22px; font-size: 28px; line-height: 1.2;">
                Password Reset Request
            </h1>

            <p style="text-align: center; color: #8b929c; font-size: 16px; line-height: 1.6; margin: 0;">
                Hello ${username}, we received a request to reset your account's password. Click the button below to proceed.
            </p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${link}" style="background-color: #00e676; color: #000; padding: 14px 28px; font-weight: 800; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 15px;">
                    Reset Password
                </a>
            </div>

            <p style="font-size: 12px; color: #5a616b; text-align: center; margin: 0;">
                This link will expire in 1 hour. If you didn't request this, you can safely ignore this email.
            </p>
        </div>
        `
    });
}

app.post('/api/register', async (req, res) => {
    const { username, password, email, captchaToken } = req.body;
    const SECRET_KEY = process.env.RECAPTCHA_SECRET;

    try {
        const params = new URLSearchParams();
        params.append('secret', SECRET_KEY);
        params.append('response', captchaToken);

        const googleRes = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            params
        );

        if (!googleRes.data.success) {
            return res.status(400).json({ error: "bro is a bot" });
        }
    } catch (err) {
        return res.status(500).json({ error: "Error verifying CAPTCHA." });
    }

    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: "Please enter a valid email address." });
    }
    const userError = validateUsername(username);
    if (userError) return res.status(400).json({ error: userError });

    const passError = validatePassword(password);
    if (passError) return res.status(400).json({ error: passError });

    try {
        const usernameCheck = await pool.query(
            `SELECT id FROM users WHERE LOWER(username) = LOWER($1) 
             UNION 
             SELECT 1 FROM pending_users WHERE LOWER(username) = LOWER($1)`,
            [username]
        );

        if (usernameCheck.rows.length > 0) {
            return res.status(400).json({ error: "That username is already taken." });
        }

        const emailCheck = await pool.query(
            `SELECT id FROM users WHERE LOWER(email) = LOWER($1)
             UNION
             SELECT 1 FROM pending_users WHERE LOWER(email) = LOWER($1)
             UNION
             SELECT 1 FROM pending_email_changes
             WHERE LOWER(email) = LOWER($1) AND expires_at > NOW()`,
            [email]
        );

        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ error: "That email is already in use." });
        }

        const token = randomBytes(32).toString('hex');
        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.query(
            'INSERT INTO pending_users (token, username, password_hash, email) VALUES ($1, $2, $3, $4)',
            [token, username, hashedPassword, email]
        );

        const verifyLink = `https://webdemonlist.org/verify?token=${token}`;        
        await sendVerificationEmail(email, username, verifyLink);

        res.json({ message: "Verification email sent! Please check your inbox (and spam folder)." });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "An error occurred during registration." });
    }
});

app.get('/api/verify', async (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) {
        return res.status(400).json({ error: "Missing verification token." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const pendingRegistration = await client.query(
            'SELECT * FROM pending_users WHERE token = $1 FOR UPDATE',
            [token]
        );

        if (pendingRegistration.rows.length) {
            const user = pendingRegistration.rows[0];

            await client.query(
                'INSERT INTO users (username, password_hash, email) VALUES ($1, $2, $3)',
                [user.username, user.password_hash, user.email]
            );
            await client.query('DELETE FROM pending_users WHERE token = $1', [token]);
            await client.query('COMMIT');

            return res.status(200).json({
                message: "Your account is now active. You may now log in.",
                verificationType: 'account',
            });
        }

        const pendingEmailResult = await client.query(`
            SELECT user_id, email, expires_at
            FROM pending_email_changes
            WHERE token = $1
            FOR UPDATE
        `, [token]);
        const pendingEmail = pendingEmailResult.rows[0];

        if (!pendingEmail) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "This link is invalid or has already been used." });
        }

        if (new Date(pendingEmail.expires_at).getTime() <= Date.now()) {
            await client.query('DELETE FROM pending_email_changes WHERE token = $1', [token]);
            await client.query('COMMIT');
            return res.status(400).json({ error: "This email verification link has expired." });
        }

        const duplicate = await client.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2 LIMIT 1',
            [pendingEmail.email, pendingEmail.user_id]
        );
        if (duplicate.rows.length) {
            await client.query('DELETE FROM pending_email_changes WHERE token = $1', [token]);
            await client.query('COMMIT');
            return res.status(409).json({ error: "That email address is already in use." });
        }

        const updated = await client.query(
            'UPDATE users SET email = $1 WHERE id = $2 RETURNING id',
            [pendingEmail.email, pendingEmail.user_id]
        );
        if (!updated.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "The account for this email change no longer exists." });
        }

        await client.query(
            'DELETE FROM pending_email_changes WHERE user_id = $1',
            [pendingEmail.user_id]
        );
        await client.query('COMMIT');

        return res.status(200).json({
            message: "Your email address has been updated successfully.",
            verificationType: 'email-change',
            email: pendingEmail.email,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Verification error:', err);
        return res.status(500).json({ error: "Internal server error during verification." });
    } finally {
        client.release();
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const userResult = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    
    if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (validPassword) {
            if (user.account_disabled && !isStaffRole(user.role)) {
                return res.status(403).json({
                    error: "This account has been disabled. \n Reason: " + (user.account_disabled_reason || "Banned"),
                    accountDisabled: true,
                });
            }
            req.session.userId = user.id;
            req.session.username = user.username;
            return res.json({ message: "Logged in!", username: user.username });
        }
    }
    res.status(401).json({ error: "Invalid credentials" });
});

app.get('/api/me', async (req, res) => {
    if (req.session.userId) {
        try {
            const user = await pool.query(
                'SELECT id, username, role, display_name, icon_type, icon_id, color1, color2, glow, leaderboard_banned, account_disabled FROM users WHERE id = $1', 
                [req.session.userId]
            );

            if (user.rows.length > 0) {
                const userData = user.rows[0];
                const clanTags = await getClanTagsForUsers(pool, [userData.id]);
                const clanName = clanTags.get(Number(userData.id)) || '';
                res.json({ 
                    loggedIn: true, 
                    username: userData.username, 
                    role: userData.role,
                    clanName,
                    leaderboardBanned: Boolean(userData.leaderboard_banned),
                    accountDisabled: Boolean(userData.account_disabled),
                    displayName: formatClanDisplayName(userData.display_name || userData.username, clanName),
                    icon: {
                        type: userData.icon_type || 'cube',
                        id: readProfileInt(userData.icon_id, 1),
                        color1: readProfileInt(userData.color1, 12),
                        color2: readProfileInt(userData.color2, 3),
                        glow: readProfileInt(userData.glow, -1),
                    },
                });
            } else {
                res.json({ loggedIn: false });
            }
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: "Database error" });
        }
    } else {
        res.json({ loggedIn: false });
    }
});
app.post('/api/logout', (req, res) => {
    req.session = null;
    res.json({ message: "Logged out" });
});

app.post('/api/submit', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "You must be logged in!" });
    }

    const { demonId, percentage, videoUrl, enjoymentRating } = req.body;
    const newPercent = parseInt(percentage);
    const normalizedEnjoyment = normalizeEnjoymentRating(enjoymentRating, newPercent);
    
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (isNaN(newPercent) || newPercent <= 0) {
        return res.status(400).json({ error: "Percentage must be a valid number greater than 0%." });
    }

    if (newPercent > 100) {
        return res.status(400).json({ error: "Percentage cannot be higher than 100%." });
    }

    if (enjoymentRating !== '' && enjoymentRating !== null && enjoymentRating !== undefined && normalizedEnjoyment === null) {
        return res.status(400).json({ error: "Enjoyment rating must be between 1 and 10 and can only be used for 100% records." });
    }

    const urlPattern = new RegExp('^(https?:\\/\\/)?' + 
        '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' +
        '((\\d{1,3}\\.){3}\\d{1,3}))' +
        '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*' +
        '(\\?[;&a-z\\d%_.~+=-]*)?' +
        '(\\#[-a-z\\d_]*)?$', 'i');
    
    if (!urlPattern.test(videoUrl)) {
        return res.status(400).json({ error: "Please enter a valid URL." });
    }

    try {
        const demonQuery = await pool.query(
            'SELECT position, requirement, list_type FROM demons WHERE id = $1', 
            [demonId]
        );
        
        if (demonQuery.rows.length === 0) return res.status(404).json({ error: "Level not found." });
        
        const { position, requirement, list_type } = demonQuery.rows[0];

        if (list_type === 'primary' && position > 150) {
            return res.status(400).json({ error: "Submissions for the Legacy List are disabled." });
        }

        if (list_type !== list) {
            return res.status(400).json({ error: "This level does not belong to the active list." });
        }

        if (list === 'primary') {
            if (position > 75) {
                if (newPercent < 100) {
                    return res.status(400).json({ 
                        error: "This level is on the Extended List, you must get 100% lol" 
                    });
                }
            } else {
                if (newPercent < requirement) {
                    return res.status(400).json({ error: `Level requires at least ${requirement}%.` });
                }
            }
        }

        const existingRecord = await pool.query(
            `SELECT id, percentage FROM records 
             WHERE user_id = $1 AND demon_id = $2 AND list_type = $3 AND status != 'rejected'`,
            [req.session.userId, demonId, list]
        );

        if (existingRecord.rows.length > 0) {
            const oldPercent = existingRecord.rows[0].percentage;

            if (newPercent <= oldPercent) {
                return res.status(400).json({ 
                    error: `You already have an active ${oldPercent}% record. New entries must be a higher percentage.` 
                });
            }

            await pool.query(
                `UPDATE records 
                 SET percentage = $1, video_url = $2, enjoyment_rating = $3, status = 'pending' 
                 WHERE id = $4`,
                [newPercent, videoUrl, normalizedEnjoyment, existingRecord.rows[0].id]
            );
            const leaderboardSync = await syncLeaderboardTopOne(list);
            for (const changedUserId of leaderboardSync.changedUserIds || []) {
                await evaluateUserBadges(changedUserId, list);
            }
            return res.json({ message: "Record updated and awaiting review!" });
        }

        await pool.query(
            `INSERT INTO records (user_id, demon_id, percentage, video_url, enjoyment_rating, list_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
            [req.session.userId, demonId, newPercent, videoUrl, normalizedEnjoyment, list]
        );
        
        res.json({ message: "Record submitted successfully!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error." });
    }
});


app.get('/api/records/pending', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const result = await pool.query(`
            SELECT r.id, r.demon_id, r.percentage, r.video_url, r.enjoyment_rating,
                   r.created_at, d.name AS demon_name, d.position, d.requirement
            FROM records r
            JOIN demons d ON d.id = r.demon_id
            WHERE r.user_id = $1 AND r.status = 'pending' AND r.list_type = $2
            ORDER BY r.created_at DESC, r.id DESC
        `, [req.session.userId, list]);
        res.json(result.rows);
    } catch (err) {
        console.error('Pending record fetch error:', err);
        res.status(500).json({ error: "Could not load pending records." });
    }
});

app.patch('/api/records/pending/:recordId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const recordId = parseInt(req.params.recordId, 10);
    const percentage = parseInt(req.body.percentage, 10);
    const videoUrl = String(req.body.videoUrl || '').trim();
    const enjoymentRating = normalizeEnjoymentRating(req.body.enjoymentRating, percentage);

    if (!Number.isInteger(recordId) || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
        return res.status(400).json({ error: "Percentage must be between 1 and 100." });
    }
    if (!isValidHttpUrl(videoUrl)) {
        return res.status(400).json({ error: "Please enter a valid video URL." });
    }
    if (req.body.enjoymentRating !== '' && req.body.enjoymentRating !== null && req.body.enjoymentRating !== undefined && enjoymentRating === null) {
        return res.status(400).json({ error: "Enjoyment rating must be between 1 and 10 and can only be used for 100% records." });
    }

    try {
        const recordResult = await pool.query(`
            SELECT r.id, d.position, d.requirement, d.list_type
            FROM records r
            JOIN demons d ON d.id = r.demon_id
            WHERE r.id = $1 AND r.user_id = $2 AND r.status = 'pending' AND r.list_type = $3
        `, [recordId, req.session.userId, list]);
        const record = recordResult.rows[0];
        if (!record) return res.status(404).json({ error: "Pending record not found." });

        if (list === 'primary') {
            if (Number(record.position) > 150) {
                return res.status(400).json({ error: "Legacy List submissions are disabled." });
            }
            if (Number(record.position) > 75 && percentage !== 100) {
                return res.status(400).json({ error: "Extended List records must be 100%." });
            }
            if (Number(record.position) <= 75 && percentage < Number(record.requirement)) {
                return res.status(400).json({ error: `This level requires at least ${record.requirement}%.` });
            }
        }

        await pool.query(`
            UPDATE records
            SET percentage = $1, video_url = $2, enjoyment_rating = $3
            WHERE id = $4
        `, [percentage, videoUrl, enjoymentRating, recordId]);
        res.json({ message: "Pending record updated." });
    } catch (err) {
        console.error('Pending record update error:', err);
        res.status(500).json({ error: "Could not update pending record." });
    }
});

app.delete('/api/records/pending/:recordId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const recordId = parseInt(req.params.recordId, 10);
    if (!Number.isInteger(recordId)) return res.status(400).json({ error: "Invalid record." });

    try {
        const result = await pool.query(`
            DELETE FROM records
            WHERE id = $1 AND user_id = $2 AND status = 'pending' AND list_type = $3
            RETURNING id
        `, [recordId, req.session.userId, list]);
        if (!result.rows.length) return res.status(404).json({ error: "Pending record not found." });
        res.json({ message: "Pending record deleted." });
    } catch (err) {
        console.error('Pending record delete error:', err);
        res.status(500).json({ error: "Could not delete pending record." });
    }
});

const isOwner = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).send("Not logged in");

    try {
        const user = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const userRole = user.rows[0]?.role;

        if (userRole === 'owner') {
            next();
        } else {
            res.status(403).send("Access Denied :)");
        }
    } catch (err) {
        console.error("Auth middleware error:", err);
        res.status(500).send("Internal Server Error");
    }
};

app.post('/api/owner/users/:userId/badges', isOwner, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    const groupId = String(req.body.groupId || '').trim();
    const tierId = Number(req.body.tierId);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (list === 'impossible') {
        return res.status(404).json({ error: 'Badges are not available on the ILL.' });
    }

    if (!Number.isInteger(targetUserId) || !groupId || !Number.isInteger(tierId)) {
        return res.status(400).json({ error: 'Invalid badge selection.' });
    }

    try {
        const config = loadBadgeConfig();
        const group = config.groups.find(item => String(item.id) === groupId);
        const tier = (Array.isArray(group?.tiers) ? group.tiers : [])
            .find(item => Number(item.id) === tierId);
        if (!group || !tier) return res.status(404).json({ error: 'Badge not found.' });
        if (group?.requirement?.type !== 'owner_only') {
            return res.status(403).json({ error: 'This badge is awarded automatically.' });
        }

        const targetResult = await pool.query('SELECT id FROM users WHERE id = $1', [targetUserId]);
        if (!targetResult.rows.length) return res.status(404).json({ error: 'User not found.' });

        const badgeListType = group.scope === 'global' ? 'global' : list;
        const badgeEntry = {
            groupId,
            tierId,
            listType: badgeListType,
            unlockedAt: new Date().toISOString(),
            metadata: {
                manuallyGranted: true,
                grantedBy: Number(req.session.userId),
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
                    AND COALESCE(stored.entry->>'listType', 'primary') = $5
              )
            RETURNING id
        `, [targetUserId, JSON.stringify([badgeEntry]), groupId, String(tierId), badgeListType]);

        if (!inserted.rows.length) {
            return res.status(409).json({ error: 'This user already has that badge.' });
        }

        await createInboxNotification(pool, {
            userId: targetUserId,
            actorId: req.session.userId,
            listType: list,
            type: 'badge_unlocked',
            senderName: 'WBDL',
            subject: 'New Badge Unlocked!',
            body: `You unlocked **${tier.name || `Badge ${tierId}`}**.\n\n${tier.description || ''}`,
        });

        res.json({ message: `${tier.name || 'Badge'} added.` });
    } catch (err) {
        console.error('Manual badge grant error:', err);
        res.status(500).json({ error: 'Could not add badge.' });
    }
});

const isAdmin = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).send("Not logged in");

    try {
        const user = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const userRole = user.rows[0]?.role;

        if (userRole === 'admin' || userRole === 'owner') {
            next();
        } else {
            res.status(403).send("Access Denied :)");
        }
    } catch (err) {
        console.error("Auth middleware error:", err);
        res.status(500).send("Internal Server Error");
    }
};

const isMod = async (req, res, next) => {
    if (!req.session.userId) return res.status(401).send("Not logged in");

    try {
        const user = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const userRole = user.rows[0]?.role;

        const allowedRoles = ['moderator', 'admin', 'owner'];

        if (allowedRoles.includes(userRole)) {
            next();
        } else {
            res.status(403).send("Access Denied :)");
        }
    } catch (err) {
        console.error("Mod middleware error:", err);
        res.status(500).send("Internal Server Error");
    }
};

app.get('/api/moderation/users/:userId', isMod, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: "Invalid user." });

    try {
        const [viewerResult, targetResult] = await Promise.all([
            pool.query('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId]),
            pool.query(`
                SELECT id, username, display_name, role, leaderboard_banned, leaderboard_ban_reason,
                       account_disabled, account_disabled_reason
                FROM users WHERE id = $1
            `, [targetUserId]),
        ]);

        const viewer = viewerResult.rows[0];
        const target = targetResult.rows[0];
        if (!target) return res.status(404).json({ error: "User not found." });
        if (!viewer || Number(viewer.id) === Number(target.id)) {
            return res.status(403).json({ error: "You cannot moderate this account." });
        }
        if (!canModerateTargetRole(viewer.role, target.role)) {
            return res.status(403).json({ error: "Only the owner can moderate staff members." });
        }

        res.json({
            viewerRole: viewer?.role || '',
            viewerId: viewer?.id || null,
            target: {
                ...target,
                leaderboard_banned: Boolean(target.leaderboard_banned),
                account_disabled: Boolean(target.account_disabled),
                protectedFromBans: isStaffRole(target.role),
            },
        });
    } catch (err) {
        console.error('Moderation profile load error:', err);
        res.status(500).json({ error: "Could not load moderation controls." });
    }
});

app.post('/api/moderation/users/:userId/leaderboard-ban', isMod, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    if (typeof req.body.banned !== 'boolean') {
        return res.status(400).json({ error: "The banned state must be true or false." });
    }
    const banned = req.body.banned;
    const reason = cleanProfileText(req.body.reason, 1000);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: "Invalid user." });

    try {
        const [actorResult, targetResult] = await Promise.all([
            pool.query('SELECT username, role FROM users WHERE id = $1', [req.session.userId]),
            pool.query('SELECT username, role FROM users WHERE id = $1', [targetUserId]),
        ]);
        const actor = actorResult.rows[0];
        const target = targetResult.rows[0];
        if (!target) return res.status(404).json({ error: "User not found." });
        if (isStaffRole(target.role)) {
            return res.status(403).json({ error: "Moderators, admins, and the owner are protected from leaderboard bans." });
        }

        await pool.query(`
            UPDATE users
            SET leaderboard_banned = $1,
                leaderboard_ban_reason = $2,
                leaderboard_banned_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
                leaderboard_banned_by = CASE WHEN $1 THEN $3::integer ELSE NULL END
            WHERE id = $4
        `, [banned, banned ? (reason || null) : null, req.session.userId, targetUserId]);

        await createInboxNotification(pool, {
            userId: targetUserId,
            actorId: req.session.userId,
            type: banned ? 'leaderboard_ban' : 'leaderboard_unban',
            reason: reason || null,
            listType: list,
            subject: banned ? 'Leaderboard access suspended' : 'Leaderboard access restored',
            body: banned
                ? `You have been banned from the WBDL leaderboard.${reason ? `\n\n**Reason:** ${reason}` : ''}`
                : 'Your leaderboard ban has been removed! Your records will count toward the leaderboard again.',
        });

        const sync = await syncLeaderboardTopOne(list);
        for (const userId of new Set([targetUserId, ...(sync.changedUserIds || [])])) {
            if (userId) await evaluateUserBadges(userId, list);
        }
        res.json({ message: banned ? "User leaderboard banned." : "Leaderboard ban removed." });
    } catch (err) {
        console.error('Leaderboard ban error:', err);
        res.status(500).json({ error: "Could not update leaderboard ban." });
    }
});

app.post('/api/admin/users/:userId/disable', isAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    if (typeof req.body.disabled !== 'boolean') {
        return res.status(400).json({ error: "The disabled state must be true or false." });
    }
    const disabled = req.body.disabled;
    const reason = cleanProfileText(req.body.reason, 1000);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: "Invalid user." });

    try {
        const targetResult = await pool.query('SELECT username, role FROM users WHERE id = $1', [targetUserId]);
        const target = targetResult.rows[0];
        if (!target) return res.status(404).json({ error: "User not found." });
        if (isStaffRole(target.role)) {
            return res.status(403).json({ error: "Moderators, admins, and the owner cannot be disabled." });
        }

        await pool.query(`
            UPDATE users
            SET account_disabled = $1,
                account_disabled_reason = $2,
                account_disabled_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
                account_disabled_by = CASE WHEN $1 THEN $3::integer ELSE NULL END
            WHERE id = $4
        `, [disabled, disabled ? (reason || null) : null, req.session.userId, targetUserId]);

        await createInboxNotification(pool, {
            userId: targetUserId,
            actorId: req.session.userId,
            type: disabled ? 'account_disabled' : 'account_enabled',
            reason: reason || null,
            listType: list,
            subject: disabled ? 'Account disabled' : 'Account re-enabled',
            body: disabled
                ? `Your WBDL account has been disabled.${reason ? `\n\n**Reason:** ${reason}` : ''}`
                : 'Your WBDL account has been re-enabled. You may sign in and use the site again.',
        });

        const sync = await syncLeaderboardTopOne(list);
        for (const userId of new Set([targetUserId, ...(sync.changedUserIds || [])])) {
            if (userId) await evaluateUserBadges(userId, list);
        }
        res.json({ message: disabled ? "Account disabled." : "Account re-enabled." });
    } catch (err) {
        console.error('Account disable error:', err);
        res.status(500).json({ error: "Could not update account state." });
    }
});

app.post('/api/owner/users/:userId/role', isOwner, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    const requestedRole = String(req.body.role || '').trim().toLowerCase();
    const reason = cleanProfileText(req.body.reason, 1000);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (!Number.isInteger(targetUserId)) {
        return res.status(400).json({ error: 'Invalid user.' });
    }
    if (!['member', 'moderator', 'admin'].includes(requestedRole)) {
        return res.status(400).json({ error: 'Invalid role.' });
    }
    if (Number(req.session.userId) === targetUserId) {
        return res.status(400).json({ error: 'You cannot change your own role.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const targetResult = await client.query(
            'SELECT id, username, role FROM users WHERE id = $1 FOR UPDATE',
            [targetUserId]
        );
        const target = targetResult.rows[0];

        if (!target) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found.' });
        }

        const currentRole = String(target.role || 'member').toLowerCase();
        const normalizedCurrentRole = currentRole === 'user' ? 'member' : currentRole;

        if (normalizedCurrentRole === 'owner') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'The owner account role cannot be changed.' });
        }
        if (normalizedCurrentRole === requestedRole) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `This user is already a ${requestedRole}.` });
        }

        await client.query(`
            UPDATE users
            SET role = $1,
                leaderboard_banned = FALSE,
                leaderboard_ban_reason = NULL,
                leaderboard_banned_at = NULL,
                leaderboard_banned_by = NULL,
                account_disabled = FALSE,
                account_disabled_reason = NULL,
                account_disabled_at = NULL,
                account_disabled_by = NULL
            WHERE id = $2
        `, [requestedRole, targetUserId]);

        const roleLabel = requestedRole.charAt(0).toUpperCase() + requestedRole.slice(1);
        const roleRanks = { member: 0, moderator: 1, admin: 2 };
        const roleChangeType = roleRanks[requestedRole] > (roleRanks[normalizedCurrentRole] ?? 0)
            ? 'promoted'
            : 'demoted';
        await createInboxNotification(client, {
            userId: targetUserId,
            actorId: req.session.userId,
            type: 'role_changed',
            reason: reason || null,
            listType: list,
            subject: `You have been ${roleChangeType} to ${roleLabel}`,
            body: `Your WBDL account role was changed to **${roleLabel}** by the owner.${reason ? `\n\n**Reason:** ${reason}` : ''}`,
        });

        for (const listType of ['primary', 'impossible']) {
            const sync = await syncLeaderboardTopOne(listType, client);
            for (const userId of new Set([targetUserId, ...(sync.changedUserIds || [])])) {
                if (userId) await evaluateUserBadges(userId, listType, client);
            }
        }

        await client.query('COMMIT');

        res.json({
            message: `${target.username}'s role was changed to ${roleLabel}.`,
            role: requestedRole,
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Role change error:', err);
        res.status(500).json({ error: 'Could not change this user role.' });
    } finally {
        client.release();
    }
});

app.patch('/api/admin/users/:userId/username', isAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    const username = String(req.body.username || '').trim();
    const reason = cleanProfileText(req.body.reason, 1000);
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: "Invalid user." });
    const formatError = validateUsername(username);
    if (formatError) return res.status(400).json({ error: formatError });

    try {
        const [actorResult, targetResult, duplicate] = await Promise.all([
            pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]),
            pool.query('SELECT username, role FROM users WHERE id = $1', [targetUserId]),
            pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', [username, targetUserId]),
        ]);
        const actorRole = actorResult.rows[0]?.role;
        const target = targetResult.rows[0];
        if (!target) return res.status(404).json({ error: "User not found." });
        if (!canModerateTargetRole(actorRole, target.role)) {
            return res.status(403).json({ error: "Only the owner can moderate staff members." });
        }
        if (duplicate.rows.length) return res.status(400).json({ error: "That username is already taken." });

        await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, targetUserId]);
        await createInboxNotification(pool, {
            userId: targetUserId,
            actorId: req.session.userId,
            type: 'username_moderated',
            subject: 'Your username was moderated.',
            body: `Your username was changed from **${target.username}** to **${username}**.${reason ? `\n\n**Reason:** ${reason}` : ''}`,
        });
        res.json({ message: "Username updated.", username });
    } catch (err) {
        console.error('Username moderation error:', err);
        res.status(500).json({ error: "Could not update username." });
    }
});

app.patch('/api/admin/users/:userId/records/:recordId', isAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    const recordId = parseInt(req.params.recordId, 10);
    const percentage = parseInt(req.body.percentage, 10);
    const videoUrl = String(req.body.videoUrl || '').trim();
    const status = String(req.body.status || '').toLowerCase();
    const reason = cleanProfileText(req.body.reason, 1000);
    const enjoymentRating = normalizeEnjoymentRating(req.body.enjoymentRating, percentage);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (!Number.isInteger(targetUserId) || !Number.isInteger(recordId)) return res.status(400).json({ error: "Invalid record." });
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) return res.status(400).json({ error: "Percentage must be between 1 and 100." });
    if (!isValidHttpUrl(videoUrl)) return res.status(400).json({ error: "Please enter a valid video URL." });
    if (!['pending', 'accepted', 'rejected'].includes(status)) return res.status(400).json({ error: "Invalid status." });
    if (req.body.enjoymentRating !== '' && req.body.enjoymentRating !== null && req.body.enjoymentRating !== undefined && enjoymentRating === null) {
        return res.status(400).json({ error: "Enjoyment rating must be 1-10 and only applies to 100% records." });
    }

    try {
        const [actorResult, targetResult] = await Promise.all([
            pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]),
            pool.query('SELECT role FROM users WHERE id = $1', [targetUserId]),
        ]);
        const targetRole = targetResult.rows[0]?.role;
        if (!targetResult.rows.length) return res.status(404).json({ error: "User not found." });
        if (!canModerateTargetRole(actorResult.rows[0]?.role, targetRole)) {
            return res.status(403).json({ error: "Only the owner can moderate staff members." });
        }

        const recordResult = await pool.query(`
            SELECT r.id, r.user_id, d.name AS demon_name, d.position
            FROM records r
            JOIN demons d ON d.id = r.demon_id
            WHERE r.id = $1 AND r.user_id = $2 AND r.list_type = $3
        `, [recordId, targetUserId, list]);
        const record = recordResult.rows[0];
        if (!record) return res.status(404).json({ error: "Record not found." });

        await pool.query(`
            UPDATE records
            SET percentage = $1,
                video_url = $2,
                enjoyment_rating = $3,
                status = $4,
                accepted_position = CASE WHEN $4 = 'accepted' THEN $5 ELSE accepted_position END
            WHERE id = $6
        `, [percentage, videoUrl, enjoymentRating, status, record.position, recordId]);

        await createInboxNotification(pool, {
            userId: targetUserId,
            actorId: req.session.userId,
            recordId,
            type: 'record_edited',
            reason: reason || null,
            listType: list,
            subject: `Record edited: ${record.demon_name}`,
            body: `A staff member edited your record for **${record.demon_name}**.\n\n- Percentage: **${percentage}%**\n- Status: **${status}**${enjoymentRating ? `\n- Enjoyment: **${enjoymentRating}/10**` : ''}${reason ? `\n\n**Reason:** ${reason}` : ''}`,
        });

        const sync = await syncLeaderboardTopOne(list);
        for (const userId of new Set([targetUserId, ...(sync.changedUserIds || [])])) {
            if (userId) await evaluateUserBadges(userId, list);
        }
        res.json({ message: "Record updated." });
    } catch (err) {
        console.error('Admin record edit error:', err);
        res.status(500).json({ error: "Could not update record." });
    }
});

app.delete('/api/admin/users/:userId/records/:recordId', isAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.userId, 10);
    const recordId = parseInt(req.params.recordId, 10);
    const reason = cleanProfileText(req.body?.reason, 1000);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    if (!Number.isInteger(targetUserId) || !Number.isInteger(recordId)) return res.status(400).json({ error: "Invalid record." });

    try {
        const [actorResult, targetResult] = await Promise.all([
            pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]),
            pool.query('SELECT role FROM users WHERE id = $1', [targetUserId]),
        ]);
        const targetRole = targetResult.rows[0]?.role;
        if (!targetResult.rows.length) return res.status(404).json({ error: "User not found." });
        if (!canModerateTargetRole(actorResult.rows[0]?.role, targetRole)) {
            return res.status(403).json({ error: "Only the owner can moderate staff members." });
        }

        const recordResult = await pool.query(`
            SELECT r.id, d.name AS demon_name
            FROM records r
            JOIN demons d ON d.id = r.demon_id
            WHERE r.id = $1 AND r.user_id = $2 AND r.list_type = $3
        `, [recordId, targetUserId, list]);
        const record = recordResult.rows[0];
        if (!record) return res.status(404).json({ error: "Record not found." });

        await pool.query('DELETE FROM records WHERE id = $1', [recordId]);
        await createInboxNotification(pool, {
            userId: targetUserId,
            actorId: req.session.userId,
            type: 'record_deleted',
            reason: reason || null,
            listType: list,
            subject: `Record removed: ${record.demon_name}`,
            body: `A staff member removed your record for **${record.demon_name}**.${reason ? `\n\n**Reason:** ${reason}` : ''}`,
        });

        const sync = await syncLeaderboardTopOne(list);
        for (const userId of new Set([targetUserId, ...(sync.changedUserIds || [])])) {
            if (userId) await evaluateUserBadges(userId, list);
        }
        res.json({ message: "Record deleted." });
    } catch (err) {
        console.error('Admin record delete error:', err);
        res.status(500).json({ error: "Could not delete record." });
    }
});

app.get('/api/admin/pending', isMod, async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const result = await pool.query(`
            SELECT records.*, users.username, demons.name as demon_name 
            FROM records 
            JOIN users ON records.user_id = users.id 
            JOIN demons ON records.demon_id = demons.id 
            WHERE records.status = 'pending' AND records.list_type = $1
            ORDER BY records.id ASC
        `, [list]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch pending records" });
    }
});

app.post('/api/admin/update-record', isMod, async (req, res) => {
    const { recordId, status, reason } = req.body;
    const actorId = req.session.userId;
    const activeSubdomainList = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (!['accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: "Invalid record status." });
    }

    const client = await pool.connect();
    let targetUserId = null;
    let listType = activeSubdomainList;

    try {
        await client.query('BEGIN');
        const actorQuery = await client.query('SELECT username, role FROM users WHERE id = $1', [actorId]);
        const actor = actorQuery.rows[0];

        const recordQuery = await client.query(`
            SELECT r.user_id, r.list_type, r.percentage, d.name AS demon_name, d.position,
                   u.username AS target_username, u.role AS target_role
            FROM records r
            JOIN demons d ON d.id = r.demon_id
            JOIN users u ON u.id = r.user_id
            WHERE r.id = $1
            FOR UPDATE OF r
        `, [recordId]);

        if (!recordQuery.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Record not found" });
        }

        const record = recordQuery.rows[0];
        targetUserId = record.user_id;
        listType = record.list_type;

        if (record.list_type !== activeSubdomainList) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "This record does not belong to the active list." });
        }

        if (record.user_id === actorId && actor?.role !== 'owner') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: "You cannot verify your own record!" });
        }
        if (!canModerateTargetRole(actor?.role, record.target_role)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: "Only the owner can moderate staff members." });
        }

        await client.query(`
            UPDATE records
            SET status = $1,
                accepted_position = CASE WHEN $1 = 'accepted' THEN $2 ELSE accepted_position END
            WHERE id = $3
        `, [status, record.position, recordId]);

        const accepted = status === 'accepted';
        const body = accepted
            ? `Your **${record.percentage}%** record for **${record.demon_name}** was accepted.`
            : `Your **${record.percentage}%** record for **${record.demon_name}** was rejected.${reason ? `\n\n**Reason:** ${reason}` : ''}`;

        await createInboxNotification(client, {
            userId: record.user_id,
            actorId,
            recordId,
            type: status,
            reason: reason || null,
            listType: record.list_type,
            subject: `Record ${status}: ${record.demon_name}`,
            body,
        });

        await client.query('COMMIT');

        const sync = await syncLeaderboardTopOne(listType);
        const affected = new Set([Number(targetUserId), ...(sync.changedUserIds || []).map(Number)]);
        for (const userId of affected) {
            if (userId) await evaluateUserBadges(userId, listType);
        }

        res.json({ message: `Record ${status}.` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: "Failed to update record" });
    } finally {
        client.release();
    }
});

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function sendDiscordNotification(content) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: "List Changes",
                avatar_url: "https://webdemonlist.org/assets/icon.png",
                content: `<@&1493780241628528730> ${content}`
            })
        });
    } catch (err) {
        console.error("Discord notification failed:", err);
    }
}

app.post('/api/admin/add-demon', isAdmin, async (req, res) => {
    const { name, author, position, level_id, requirement, showcase_url } = req.body;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const actorId = req.session.userId;
    const targetPos = parseInt(position);

    const client = await pool.connect();

    try {
        const userRes = await client.query('SELECT role FROM users WHERE id = $1', [actorId]);
        const userRole = userRes.rows[0]?.role;

        if (targetPos > 150 && userRole !== 'owner') {
            client.release();
            return res.status(403).json({ error: "Only the owner can place levels in the Legacy List (> 150)." });
        }

        await client.query('BEGIN');

        const boundaries = await client.query(
            `SELECT position, name FROM demons WHERE list_type = $1 AND position IN (75, 150)`,
            [list]
        );
        const old75 = boundaries.rows.find(r => r.position === 75)?.name;
        const old150 = boundaries.rows.find(r => r.position === 150)?.name;

        await client.query(
            'UPDATE demons SET position = position + 1 WHERE list_type = $2 AND position >= $1', 
            [targetPos, list]
        );

        const newLevel = await client.query(
            `INSERT INTO demons (name, author, position, level_id, requirement, list_type, showcase_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [name, author, targetPos, level_id, requirement || 0, list, showcase_url || null]
        );
        const newDemonId = newLevel.rows[0].id;

        await client.query(
            `INSERT INTO changelog (demon_id, demon_name, change_type, old_position, new_position, list_type) 
             VALUES ($1, $2, 'added', null, $3, $4)`,
            [newDemonId, name, targetPos, list]
        );

        const neighborsRes = await client.query(
            `SELECT name, position FROM demons WHERE list_type = $1 AND position IN ($2, $3)`,
            [list, targetPos - 1, targetPos + 1]
        );
        
        await client.query('COMMIT');

        if (list === 'primary') {
            const above = neighborsRes.rows.find(r => r.position == targetPos - 1)?.name;
            const below = neighborsRes.rows.find(r => r.position == targetPos + 1)?.name;

            let msg = `**${name}** has been placed at **#${targetPos}**`;
            let context = [];
            
            if (below) context.push(`above **${below}**`);
            if (above) context.push(`below **${above}**`);

            if (context.length > 0) msg += ", " + context.join(" and ");
            msg += ` with a list requirement of **${requirement}%**.`;

            let pushes = [];
            if (targetPos <= 75 && old75) pushes.push(`**${old75}** into the Extended List`);
            if (targetPos <= 150 && old150) pushes.push(`**${old150}** into the Legacy List`);
            
            if (pushes.length > 0) {
                msg += ` This change pushes ${pushes.join(" and ")}.`;
            }

            sendDiscordNotification(msg);
        }

        const leaderboardSync = await syncLeaderboardTopOne(list);
        for (const changedUserId of leaderboardSync.changedUserIds || []) {
            await evaluateUserBadges(changedUserId, list);
        }

        res.json({ message: "Demon added" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Add failed: " + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/admin/delete-demon', isOwner, async (req, res) => {
    const { id, position } = req.body;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const actorId = req.session.userId;
    const targetPos = parseInt(position);

    const client = await pool.connect();

    try {
        const userRes = await client.query('SELECT role FROM users WHERE id = $1', [actorId]);
        const userRole = userRes.rows[0]?.role;

        if (targetPos > 150 && userRole !== 'owner') {
            client.release();
            return res.status(403).json({ error: "Can't delete levels from the Legacy List." });
        }

        await client.query('BEGIN');

        const boundaries = await client.query(
            `SELECT position, name FROM demons WHERE list_type = $1 AND position IN (76, 151)`,
            [list]
        );
        const old76 = boundaries.rows.find(r => r.position === 76)?.name;
        const old151 = boundaries.rows.find(r => r.position === 151)?.name;

        const levelData = await client.query('SELECT name, list_type FROM demons WHERE id = $1', [id]);
        if (levelData.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: "Level not found" });
        }

        const { name: levelName, list_type } = levelData.rows[0];

        if (list_type !== list) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({ error: "This level does not belong to the active list layout." });
        }

        await client.query('DELETE FROM records WHERE demon_id = $1', [id]);
        
        await client.query('DELETE FROM demons WHERE id = $1', [id]);
        
        await client.query(
            'UPDATE demons SET position = position - 1 WHERE list_type = $2 AND position > $1', 
            [targetPos, list]
        );

        await client.query(
            `INSERT INTO changelog (demon_id, demon_name, change_type, old_position, new_position, list_type) 
             VALUES ($1, $2, 'deleted', $3, null, $4)`,
            [id, levelName, targetPos, list]
        );
        
        await client.query('COMMIT');

        if (list === 'primary') {
            let msg = `**${levelName}** has been removed from the list.`;

            let pushes = [];
            if (targetPos <= 75 && old76) pushes.push(`**${old76}** back to the Main List`);
            if (targetPos <= 150 && old151) pushes.push(`**${old151}** back to the Extended List`);
            
            if (pushes.length > 0) {
                msg += ` This change pushes ${pushes.join(" and ")}.`;
            }

            sendDiscordNotification(msg);
        }

        const leaderboardSync = await syncLeaderboardTopOne(list);
        for (const changedUserId of leaderboardSync.changedUserIds || []) {
            await evaluateUserBadges(changedUserId, list);
        }

        res.json({ message: "Demon removed" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Delete failed" });
    } finally {
        client.release();
    }
});

app.post('/api/admin/move-demon', isAdmin, async (req, res) => {
    const { id, oldPosition, newPosition } = req.body;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const actorId = req.session.userId;

    const oldPos = parseInt(oldPosition);
    const newPos = parseInt(newPosition);

    if (!id || !oldPos || !newPos) {
        return res.status(400).json({ error: "Missing data" });
    }
    if (oldPos === newPos) {
        return res.status(400).json({ error: "Old position and new position are the same." });
    }

    const client = await pool.connect();
    
    try {
        const userRes = await client.query('SELECT role FROM users WHERE id = $1', [actorId]);
        const userRole = userRes.rows[0]?.role;

        if ((oldPos > 150 || newPos > 150) && userRole !== 'owner') {
            client.release();
            return res.status(403).json({ error: "Only the owner can manipulate levels touching the Legacy List (> 150)." });
        }

        await client.query('BEGIN');

        const boundaries = await client.query(
            `SELECT position, name FROM demons WHERE list_type = $1 AND position IN (75, 76, 150, 151)`,
            [list]
        );
        const old75 = boundaries.rows.find(r => r.position === 75)?.name;
        const old76 = boundaries.rows.find(r => r.position === 76)?.name;
        const old150 = boundaries.rows.find(r => r.position === 150)?.name;
        const old151 = boundaries.rows.find(r => r.position === 151)?.name;

        const levelRes = await client.query('SELECT name, list_type FROM demons WHERE id = $1', [id]);
        if (levelRes.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(404).json({ error: "Level not found" });
        }

        const { name: levelName, list_type } = levelRes.rows[0];

        if (list_type !== list) {
            await client.query('ROLLBACK');
            client.release();
            return res.status(400).json({ error: "This level does not belong to the active list layout." });
        }

        if (newPos < oldPos) {
            await client.query(
                'UPDATE demons SET position = position + 1 WHERE list_type = $3 AND position >= $1 AND position < $2',
                [newPos, oldPos, list]
            );
        } else {
            await client.query(
                'UPDATE demons SET position = position - 1 WHERE list_type = $3 AND position > $1 AND position <= $2',
                [oldPos, newPos, list]
            );
        }

        await client.query('UPDATE demons SET position = $1 WHERE id = $2', [newPos, id]);
        
        await client.query(
            `INSERT INTO changelog (demon_id, demon_name, change_type, old_position, new_position, list_type) 
             VALUES ($1, $2, 'moved', $3, $4, $5)`,
            [id, levelName, oldPos, newPos, list]
        );

        const neighborsRes = await client.query(
            `SELECT name, position FROM demons WHERE list_type = $1 AND position IN ($2, $3)`,
            [list, newPos - 1, newPos + 1]
        );

        await client.query('COMMIT');

        if (list === 'primary') {
            const above = neighborsRes.rows.find(r => r.position == newPos - 1)?.name;
            const below = neighborsRes.rows.find(r => r.position == newPos + 1)?.name;
            
            const action = newPos < oldPos ? "raised" : "lowered";
            let msg = `**${levelName}** has been **${action}** to **#${newPos}**`;
            
            let context = [];
            if (below) context.push(`above **${below}**`);
            if (above) context.push(`below **${above}**`);

            if (context.length > 0) msg += ", " + context.join(" and ");
            msg += ".";

            let pushes = [];
            if (newPos < oldPos) { 
                if (newPos <= 75 && oldPos > 75 && old75) pushes.push(`**${old75}** into the Extended List`);
                if (newPos <= 150 && oldPos > 150 && old150) pushes.push(`**${old150}** into the Legacy List`);
            } else if (newPos > oldPos) { 
                if (oldPos <= 75 && newPos >= 76 && old76) pushes.push(`**${old76}** back to the Main List`);
                if (oldPos <= 150 && newPos >= 151 && old151) pushes.push(`**${old151}** back to the Extended List`);
            }

            if (pushes.length > 0) {
                msg += ` This change pushes ${pushes.join(" and ")}.`;
            }

            sendDiscordNotification(msg);
        }

        const leaderboardSync = await syncLeaderboardTopOne(list);
        for (const changedUserId of leaderboardSync.changedUserIds || []) {
            await evaluateUserBadges(changedUserId, list);
        }

        res.json({ message: "Level moved successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Database error during move execution." });
    } finally {
        client.release();
    }
});

app.get('/api/admin/pending-verifications', isAdmin, async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const result = await pool.query(`
            SELECT v.*, u.username 
            FROM verifications v
            JOIN users u ON v.user_id = u.id
            WHERE v.status = 'pending' AND v.list_type = $1
            ORDER BY v.id ASC
        `, [list]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch verifications" });
    }
});

app.post('/api/admin/reject-verification', isAdmin, async (req, res) => {
    const { verifId, reason } = req.body;
    const actorId = req.session.userId;
    const activeSubdomainList = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const verifQuery = await client.query(
            'SELECT user_id, level_name, list_type FROM verifications WHERE id = $1 FOR UPDATE',
            [verifId]
        );
        if (!verifQuery.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Verification not found" });
        }

        const { user_id, level_name, list_type } = verifQuery.rows[0];
        if (list_type !== activeSubdomainList) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "This request does not belong to the active list." });
        }

        await client.query(
            'UPDATE verifications SET status = $1, rejection_reason = $2 WHERE id = $3',
            ['rejected', reason || null, verifId]
        );

        await createInboxNotification(client, {
            userId: user_id,
            actorId,
            type: 'verif_rejected',
            reason: reason || null,
            listType: list_type,
            subject: `Verification rejected: ${level_name}`,
            body: `Your verification submission for **${level_name}** was rejected.${reason ? `\n\n**Reason:** ${reason}` : ''}`,
        });

        await client.query('COMMIT');
        res.json({ message: "Verification rejected." });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Rejection error:', err);
        res.status(500).json({ error: "Failed to reject verification: " + err.message });
    } finally {
        client.release();
    }
});

app.post('/api/admin/approve-verification', isAdmin, async (req, res) => {
    const { verifId, demonId } = req.body;
    const actorId = req.session.userId;
    const activeSubdomainList = req.currentList === 'impossible' ? 'impossible' : 'primary';
    const client = await pool.connect();
    let userId = null;
    let listType = activeSubdomainList;

    try {
        await client.query('BEGIN');
        const actorQuery = await client.query('SELECT role FROM users WHERE id = $1', [actorId]);
        const actorRole = actorQuery.rows[0]?.role;

        const verifQuery = await client.query(
            'SELECT user_id, video_url, list_type, level_name, enjoyment_rating FROM verifications WHERE id = $1 FOR UPDATE',
            [verifId]
        );
        if (!verifQuery.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Verification data missing" });
        }

        const verification = verifQuery.rows[0];
        userId = verification.user_id;
        listType = verification.list_type;

        if (verification.list_type !== activeSubdomainList) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "This request does not belong to the active list." });
        }

        if (verification.user_id === actorId && actorRole === 'admin') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: "Admins cannot approve their own level verifications!" });
        }

        await client.query('UPDATE verifications SET status = $1 WHERE id = $2', ['accepted', verifId]);

        let recordId = null;
        if (verification.list_type === 'impossible') {
            await client.query('UPDATE demons SET showcase_url = $1 WHERE id = $2', [verification.video_url, demonId]);
        } else {
            const demonResult = await client.query('SELECT position, name FROM demons WHERE id = $1', [demonId]);
            const demon = demonResult.rows[0];
            if (!demon) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: "Level not found." });
            }

            const newRecord = await client.query(`
                INSERT INTO records
                    (user_id, demon_id, percentage, video_url, status, list_type, accepted_position, enjoyment_rating)
                VALUES ($1, $2, 100, $3, 'accepted', $4, $5, $6)
                RETURNING id
            `, [
                verification.user_id,
                demonId,
                verification.video_url,
                verification.list_type,
                demon.position,
                verification.enjoyment_rating,
            ]);
            recordId = newRecord.rows[0].id;
        }

        await createInboxNotification(client, {
            userId: verification.user_id,
            actorId,
            recordId,
            type: 'verif_accepted',
            listType: verification.list_type,
            subject: `Verification accepted: ${verification.level_name}`,
            body: `Your verification for **${verification.level_name}** was accepted and added to the list.`,
        });

        await client.query('COMMIT');

        const sync = await syncLeaderboardTopOne(listType);
        for (const affectedId of new Set([Number(userId), ...(sync.changedUserIds || []).map(Number)])) {
            if (affectedId) await evaluateUserBadges(affectedId, listType);
        }

        res.json({ message: "Level verified and record added to list." });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: "Failed to finalize verification" });
    } finally {
        client.release();
    }
});

app.get('/moderators', isMod, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'moderators.html'));
});

app.get('/admin', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/profile/:username', async (req, res) => {
    const { username } = req.params;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const userResult = await pool.query(
            `SELECT id, username, created_at, role,
                    display_name, bio, pronouns, country,
                    social_youtube, social_twitter, social_twitch, social_discord, social_reddit, social_gdbrowser, discord_username,
                    icon_type, icon_id, color1, color2, glow,
                    leaderboard_banned, leaderboard_ban_reason,
                    account_disabled, account_disabled_reason
             FROM users WHERE LOWER(username) = LOWER($1)`,
            [username]
        );

        if (!userResult.rows.length) return res.status(404).json({ error: "User not found" });
        const user = userResult.rows[0];

        const recordsResult = await pool.query(`
            SELECT
                r.id AS record_id,
                r.percentage,
                r.video_url,
                r.enjoyment_rating,
                r.accepted_position,
                d.name,
                d.position,
                d.requirement,
                d.id AS demon_id,
                (
                    SELECT COUNT(*)
                    FROM records r2
                    WHERE r2.demon_id = r.demon_id
                      AND r2.status = 'accepted'
                      AND r2.percentage = 100
                      AND r2.list_type = $2
                      AND r2.id < r.id
                ) AS completion_status
            FROM records r
            JOIN demons d ON r.demon_id = d.id
            WHERE r.user_id = $1
              AND r.status = 'accepted'
              AND r.list_type = $2
              AND d.list_type = $2
            ORDER BY d.position ASC
        `, [user.id, list]);

        const recordsWithPoints = recordsResult.rows.map(r => {
            const basePoints = 250 * Math.exp(-0.0263 * (r.position - 1));
            let awardedPoints = 0;

            if (r.position > 150) {
                awardedPoints = 0;
            } else if (list === 'impossible') {
                awardedPoints = basePoints * (r.percentage / 100);
            } else if (r.percentage === 100) {
                awardedPoints = basePoints;
            } else if (r.position <= 75 && r.percentage >= r.requirement) {
                awardedPoints = basePoints / 10;
            }

            return {
                ...r,
                points: awardedPoints.toFixed(2),
                record_id: r.record_id,
                enjoyment_rating: r.enjoyment_rating == null ? null : Number(r.enjoyment_rating),
            };
        });

        const totalPoints = recordsWithPoints.reduce((sum, r) => sum + parseFloat(r.points), 0).toFixed(2);

        const sync = await syncLeaderboardTopOne(list);
        for (const changedUserId of sync.changedUserIds || []) {
            if (Number(changedUserId) !== Number(user.id)) {
                await evaluateUserBadges(changedUserId, list);
            }
        }

        const rankResult = await pool.query(`
            WITH Leaderboard AS (
                SELECT
                    u.id,
                    SUM(
                        CASE
                            WHEN d.position > 150 THEN 0
                            WHEN $2 = 'impossible' THEN
                                (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                            ELSE
                                CASE
                                    WHEN r.percentage = 100 THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                    WHEN d.position <= 75 AND r.percentage >= d.requirement THEN
                                        (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                    ELSE 0
                                END
                        END
                    ) AS total_score
                FROM users u
                JOIN records r ON u.id = r.user_id
                JOIN demons d ON r.demon_id = d.id
                WHERE r.status = 'accepted'
                  AND r.list_type = $2
                  AND d.list_type = $2
                  AND COALESCE(u.leaderboard_banned, FALSE) = FALSE
                  AND COALESCE(u.account_disabled, FALSE) = FALSE
                GROUP BY u.id
            ),
            RankedPlayers AS (
                SELECT id, total_score, RANK() OVER (ORDER BY total_score DESC) AS rank
                FROM Leaderboard
                WHERE total_score > 0
            )
            SELECT rank FROM RankedPlayers WHERE id = $1
        `, [user.id, list]);

        const leaderboardRank = rankResult.rows.length ? Number(rankResult.rows[0].rank) : 0;
        const badges = list === 'primary'
            ? await evaluateUserBadges(user.id, list)
            : [];

        let moderation = null;
        let badgeCatalog = null;
        if (req.session?.userId) {
            const viewerResult = await pool.query('SELECT id, role FROM users WHERE id = $1', [req.session.userId]);
            const viewer = viewerResult.rows[0];
            if (viewer && isStaffRole(viewer.role)) {
                moderation = {
                    viewerId: viewer.id,
                    viewerRole: viewer.role,
                    canModerate: Number(viewer.id) !== Number(user.id)
                        && canModerateTargetRole(viewer.role, user.role),
                    leaderboardBanned: Boolean(user.leaderboard_banned),
                    leaderboardBanReason: user.leaderboard_ban_reason || '',
                    accountDisabled: Boolean(user.account_disabled),
                    accountDisabledReason: user.account_disabled_reason || '',
                    targetProtectedFromBans: isStaffRole(user.role),
                };
            }
            if (viewer?.role === 'owner' && list === 'primary') {
                badgeCatalog = loadBadgeConfig().groups
                    .filter(group => group?.requirement?.type === 'owner_only')
                    .map(group => ({
                        id: String(group.id || ''),
                        scope: group.scope === 'global' ? 'global' : 'list',
                        iconPath: group.iconPath || '/assets/icon.png',
                        tiers: (Array.isArray(group.tiers) ? group.tiers : [])
                            .map(tier => ({
                                id: Number(tier.id),
                                name: String(tier.name || ''),
                                description: String(tier.description || ''),
                                iconPath: tier.iconPath || group.iconPath || '/assets/icon.png',
                            }))
                            .filter(tier => Number.isInteger(tier.id)),
                    }))
                    .filter(group => group.id);
            }
        }

        const clanTags = await getClanTagsForUsers(pool, [user.id]);
        const serializedProfile = serializeProfileUser(user);
        serializedProfile.displayName = formatClanDisplayName(
            user.display_name || user.username,
            clanTags.get(Number(user.id))
        );

        res.json({
            username: user.username,
            joined: user.created_at,
            totalPoints,
            leaderboardRank,
            records: recordsWithPoints,
            role: user.role,
            userId: user.id,
            badges,
            badgeCatalog,
            moderation,
            leaderboardBanned: Boolean(user.leaderboard_banned),
            accountDisabled: Boolean(user.account_disabled),
            ...serializedProfile,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const sync = await syncLeaderboardTopOne(list);
        for (const changedUserId of sync.changedUserIds || []) {
            await evaluateUserBadges(changedUserId, list);
        }

        const query = `
            WITH PlayerStats AS (
                SELECT 
                    u.id AS user_id,
                    u.username,
                    u.display_name,
                    u.role,
                    u.icon_type,
                    u.icon_id,
                    u.color1,
                    u.color2,
                    u.glow,
                    SUM(
                        CASE 
                            WHEN d.position > 150 THEN 0
                            
                            WHEN $1 = 'impossible' 
                                THEN (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                            ELSE
                                CASE 
                                    WHEN r.percentage = 100 
                                        THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                    WHEN d.position <= 75 AND r.percentage >= d.requirement 
                                        THEN (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                    ELSE 0 
                                END
                        END
                    ) as total_points,
                    
                    CASE 
                        WHEN $1 = 'impossible' 
                            THEN COUNT(r.id) FILTER (WHERE r.percentage = 100)
                        ELSE 
                            COUNT(r.id) FILTER (WHERE r.percentage = 100 AND d.position <= 75)
                    END as main_completions,
                    
                    CASE 
                        WHEN $1 = 'impossible' 
                            THEN 0
                        ELSE 
                            COUNT(r.id) FILTER (WHERE r.percentage = 100 AND d.position > 75 AND d.position <= 150)
                    END as extended_completions,

                    CASE
                        WHEN $1 = 'impossible'
                            THEN 0
                        ELSE
                            COUNT(r.id) FILTER (WHERE r.percentage = 100 AND d.position > 150)
                    END as legacy_completions,
                    
                    CASE 
                        WHEN $1 = 'impossible' 
                            THEN COUNT(r.id) FILTER (WHERE r.percentage < 100)
                        ELSE 
                            COUNT(r.id) FILTER (WHERE r.percentage < 100)
                    END as progress_records
                FROM users u
                JOIN records r ON u.id = r.user_id
                JOIN demons d ON r.demon_id = d.id
                WHERE r.status = 'accepted'
                  AND r.list_type = $1
                  AND d.list_type = $1
                  AND COALESCE(u.leaderboard_banned, FALSE) = FALSE
                  AND COALESCE(u.account_disabled, FALSE) = FALSE
                GROUP BY u.id, u.username, u.display_name, u.role, u.icon_type, u.icon_id, u.color1, u.color2, u.glow
            ),
            RankedPlayers AS (
                SELECT 
                    *,
                    RANK() OVER (ORDER BY total_points DESC) as leaderboard_rank
                FROM PlayerStats
            )
            SELECT * FROM RankedPlayers 
            WHERE leaderboard_rank <= 100
            ORDER BY total_points DESC;
        `;
        
        const result = await pool.query(query, [list]);
        
        const clanTags = await getClanTagsForUsers(pool, result.rows.map(row => row.user_id));
        const leaderboard = result.rows.map(row => ({
            ...row,
            displayName: formatClanDisplayName(
                row.display_name || row.username,
                clanTags.get(Number(row.user_id))
            ),
            role: row.role || '',
            icon: {
                type: row.icon_type || 'cube',
                id: readProfileInt(row.icon_id, 1),
                color1: readProfileInt(row.color1, 12),
                color2: readProfileInt(row.color2, 3),
                glow: readProfileInt(row.glow, -1),
            },
            total_points: parseFloat(row.total_points || 0).toFixed(2),
            rank: parseInt(row.leaderboard_rank)
        }));

        res.json(leaderboard);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Could not fetch leaderboard" });
    }
});

app.get('/api/demons/:id', async (req, res) => {
    const demonId = req.params.id;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    
    try {
        const demonResult = await pool.query(
            'SELECT * FROM demons WHERE id = $1', 
            [demonId]
        );
        
        if (demonResult.rows.length === 0) {
            return res.status(404).json({ error: "Demon not found" });
        }

        const demon = demonResult.rows[0];

        if (demon.list_type !== list) {
            return res.status(400).json({ error: "This level does not belong to the active list." });
        }

        const timeMachineDate = parseTimeMachineDate(req.query.date || req.query.time_machine_date);

        if (timeMachineDate) {
            const minDateValue = await getTimeMachineMinDateValue(list);

            if (isTimeMachineDateAllowed(timeMachineDate, minDateValue)) {
                const currentRows = await queryCurrentDemonSnapshotRows(list);
                const historicalRows = await buildHistoricalDemonSnapshot(currentRows, list, timeMachineDate);
                const historicalDemon = historicalRows.find(row => Number(row.id) === Number(demonId));

                if (!historicalDemon) {
                    return res.status(404).json({ error: "This level did not exist on that date." });
                }

                demon.position = historicalDemon.position;
                demon.time_machine_snapshot = true;
                demon.time_machine_date = req.query.date || req.query.time_machine_date;
            }
        }

        const recordsResult = await pool.query(`
            SELECT records.*,
                   users.id AS user_id,
                   users.username,
                   users.display_name,
                   users.role,
                   users.icon_type,
                   users.icon_id,
                   users.color1,
                   users.color2,
                   users.glow
            FROM records 
            JOIN users ON records.user_id = users.id 
            WHERE records.demon_id = $1 AND records.status = 'accepted' AND records.list_type = $2
            ORDER BY records.percentage DESC, records.id ASC
        `, [demonId, list]);

        let showcase_link = null;

        if (list === 'impossible') {
            showcase_link = demon.showcase_url;
        } else {
            const firstVictorResult = await pool.query(`
                SELECT video_url FROM records 
                WHERE demon_id = $1 AND status = 'accepted' AND list_type = $2 AND percentage = 100
                ORDER BY id ASC LIMIT 1
            `, [demonId, list]);

            showcase_link = firstVictorResult.rows.length > 0 
                ? firstVictorResult.rows[0].video_url 
                : null;
        }

        const recordClanTags = await getClanTagsForUsers(pool, recordsResult.rows.map(row => row.user_id));
        const formattedRecords = recordsResult.rows.map(row => ({
            ...row,
            displayName: formatClanDisplayName(
                row.display_name || row.username,
                recordClanTags.get(Number(row.user_id))
            ),
            role: row.role || '',
            icon: {
                type: row.icon_type || 'cube',
                id: readProfileInt(row.icon_id, 1),
                color1: readProfileInt(row.color1, 12),
                color2: readProfileInt(row.color2, 3),
                glow: readProfileInt(row.glow, -1),
            },
        }));

        const [levelUpdate, uploadDateEstimate] = await Promise.all([
            Promise.resolve(getLevelUpdateFromId(demon.level_id)),
            getEstimatedLevelUploadDate(demon.level_id)
        ]);

        res.json({ 
            ...demon, 
            showcase_link,
            level_update: levelUpdate,
            upload_date_estimate: uploadDateEstimate,
            records: formattedRecords 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});


app.get('/api/settings/profile', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        const userResult = await pool.query(`
            SELECT username, email,
                   display_name, bio, pronouns, country,
                   social_youtube, social_twitter, social_twitch, social_discord, social_reddit, social_gdbrowser, discord_username,
                   icon_type, icon_id, color1, color2, glow
            FROM users
            WHERE id = $1
        `, [req.session.userId]);

        if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });

        const user = userResult.rows[0];
        res.json({
            username: user.username,
            email: user.email || '',
            ...serializeProfileUser(user),
        });
    } catch (err) {
        console.error("Profile settings load error:", err);
        res.status(500).json({ error: "Server error." });
    }
});

app.post('/api/settings/profile', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const rawDisplayName = String(req.body.displayName || '');
    if (/[\[\]\(\)]/.test(rawDisplayName)) {
        return res.status(400).json({ error: 'Invalid display name.' });
    }

    const socialLinks = req.body.socialLinks || {};
    const icon = cleanProfileIcon(req.body.icon || {});

    const profile = {
        displayName: cleanProfileText(rawDisplayName, 40),
        bio: cleanProfileText(req.body.bio, 500),
        pronouns: cleanProfileText(req.body.pronouns, 60),
        country: cleanProfileText(req.body.country, 80),
        youtube: cleanProfileText(socialLinks.youtube, 200),
        twitter: cleanProfileText(socialLinks.twitter, 200),
        twitch: cleanProfileText(socialLinks.twitch, 200),
        reddit: cleanProfileText(socialLinks.reddit, 200),
        gdbrowser: cleanProfileText(socialLinks.gdbrowser, 200),
        iconType: icon.type,
        iconId: icon.id,
        color1: icon.color1,
        color2: icon.color2,
        glow: icon.glow,
    };

    try {
        await pool.query(`
            UPDATE users
            SET display_name = $1,
                bio = $2,
                pronouns = $3,
                country = $4,
                social_youtube = $5,
                social_twitter = $6,
                social_twitch = $7,
                social_reddit = $8,
                social_gdbrowser = $9,
                icon_type = $10,
                icon_id = $11,
                color1 = $12,
                color2 = $13,
                glow = $14
            WHERE id = $15
        `, [
            profile.displayName,
            profile.bio,
            profile.pronouns,
            profile.country,
            profile.youtube,
            profile.twitter,
            profile.twitch,
            profile.reddit,
            profile.gdbrowser,
            profile.iconType,
            profile.iconId,
            profile.color1,
            profile.color2,
            profile.glow,
            req.session.userId,
        ]);

        res.json({ message: "Profile updated successfully!" });
    } catch (err) {
        console.error("Profile settings update error:", err);
        res.status(500).json({ error: "Server error." });
    }
});

app.post('/api/settings/username', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    
    const { username } = req.body;
    const formatError = validateUsername(username);
    if (formatError) return res.status(400).json({ error: formatError });

    try {
        const existingUser = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2',
            [username, req.session.userId]
        );
        
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: "That username is already taken." });
        }

        await pool.query(
            'UPDATE users SET username = $1 WHERE id = $2', 
            [username, req.session.userId]
        );

        req.session.username = username;
        res.json({ message: "Username updated successfully!" });
    } catch (err) {
        console.error("Username update error:", err);
        res.status(500).json({ error: "Server error." });
    }
});

app.post('/api/settings/email', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const email = normalizeEmail(req.body.email);
    const currentPassword = String(req.body.currentPassword || '');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Please enter a valid email address." });
    }
    if (!currentPassword) {
        return res.status(400).json({ error: "Enter your current password to change your email." });
    }

    let verificationToken = null;
    try {
        const userResult = await pool.query(
            'SELECT id, username, password_hash, email FROM users WHERE id = $1',
            [req.session.userId]
        );
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ error: "User not found." });

        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) return res.status(400).json({ error: "Current password incorrect." });
        if (normalizeEmail(user.email) === email) {
            return res.status(400).json({ error: "That is already your current email address." });
        }

        const duplicate = await pool.query(`
            SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2
            UNION ALL
            SELECT NULL AS id FROM pending_users WHERE LOWER(email) = LOWER($1)
            UNION ALL
            SELECT user_id AS id
            FROM pending_email_changes
            WHERE LOWER(email) = LOWER($1)
              AND user_id != $2
              AND expires_at > NOW()
            LIMIT 1
        `, [email, req.session.userId]);
        if (duplicate.rows.length) {
            return res.status(400).json({ error: "That email is already in use." });
        }

        verificationToken = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await pool.query('DELETE FROM pending_email_changes WHERE expires_at <= NOW() OR user_id = $1', [
            req.session.userId,
        ]);
        await pool.query(`
            INSERT INTO pending_email_changes (token, user_id, email, expires_at)
            VALUES ($1, $2, $3, $4)
        `, [verificationToken, req.session.userId, email, expiresAt]);

        const verifyLink = `https://webdemonlist.org/verify?token=${verificationToken}&type=email-change`;
        try {
            await sendEmailChangeVerification(email, user.username, verifyLink);
        } catch (emailError) {
            await pool.query('DELETE FROM pending_email_changes WHERE token = $1', [verificationToken]);
            throw emailError;
        }

        res.json({
            message: "Verification sent to the provided email.",
            pendingEmail: email,
        });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: "That email is already in use." });
        }
        console.error('Email update error:', err);
        res.status(500).json({ error: "Could not send the email verification message." });
    }
});

app.post('/api/settings/password', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const { currentPassword, newPassword } = req.body;

    const passError = validatePassword(newPassword);
    if (passError) return res.status(400).json({ error: passError });

    try {
        const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
        
        const isMatch = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
        if (!isMatch) return res.status(400).json({ error: "Current password incorrect." });

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashedNewPassword, req.session.userId]);
        
        res.json({ message: "Password updated!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error." });
    }
});

app.delete('/api/settings/delete', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const { password } = req.body;
    const userId = req.session.userId;
    const client = await pool.connect();

    try {
        const userRes = await client.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: "User not found." });

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: "Incorrect password. Account was not deleted." });
        }

        await client.query('BEGIN');
        await client.query('DELETE FROM records WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
        await client.query('COMMIT');

        for (const list of ['primary', 'impossible']) {
            const sync = await syncLeaderboardTopOne(list);
            for (const changedUserId of sync.changedUserIds || []) {
                await evaluateUserBadges(changedUserId, list);
            }
        }

        req.session = null;
        res.json({ message: "Account deleted." });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: "Server error during deletion." });
    } finally {
        client.release();
    }
});

app.get('/api/notifications', async (req, res) => {
    if (!req.session.userId) return res.status(401).json([]);

    try {
        const result = await pool.query(`
            SELECT
                n.id,
                n.subject,
                n.body,
                n.created_at,
                n.is_read,
                n.type,
                n.list_type,
                COALESCE(NULLIF(u.display_name, ''), u.username, n.sender_name, 'WBDL') AS sent_by
            FROM notifications n
            LEFT JOIN users u ON n.actor_id = u.id
            WHERE n.user_id = $1
            ORDER BY n.created_at DESC, n.id DESC
        `, [req.session.userId]);

        res.json(result.rows.map(row => ({
            ...row,
            subject: row.subject || 'Notification',
            body: row.body || '',
            sent_by: row.sent_by || 'WBDL',
        })));
    } catch (err) {
        console.error('Notification fetch error:', err);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/notifications/read', async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);
    const notificationId = parseInt(req.body?.notificationId, 10);

    try {
        if (Number.isInteger(notificationId)) {
            await pool.query(
                'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2',
                [notificationId, req.session.userId]
            );
        } else {
            await pool.query(
                'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
                [req.session.userId]
            );
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Notification read error:', err);
        res.sendStatus(500);
    }
});

app.get('/api/demons/:id/history', async (req, res) => {
    const demonId = parseInt(req.params.id, 10);
    const client = await pool.connect();

    try {
        const currentRes = await client.query(
            'SELECT position, list_type FROM demons WHERE id = $1',
            [demonId]
        );

        if (currentRes.rows.length === 0) {
            const lifeCheck = await client.query(
                "SELECT old_position, list_type FROM changelog WHERE demon_id = $1 AND change_type = 'deleted' LIMIT 1",
                [demonId]
            );

            if (lifeCheck.rows.length === 0) {
                return res.status(404).json({ error: "Demon not found in list or records" });
            }

            return res.json([]);
        }

        const { position: currentActualPosRaw, list_type: listType } = currentRes.rows[0];
        const currentActualPos = parseInt(currentActualPosRaw, 10);

        const changelogRes = await client.query(
            `SELECT id, demon_id, demon_name, change_type, old_position, new_position, created_at 
             FROM changelog 
             WHERE list_type = $1 
             ORDER BY created_at DESC, id DESC`,
            [listType]
        );

        const virtualHistory = [];
        let simulatedPos = currentActualPos;

        for (const log of changelogRes.rows) {
            let generatedLog = null;

            if (log.demon_id === demonId) {
                if (log.change_type === 'added') {
                    generatedLog = {
                        created_at: log.created_at,
                        change_type: 'added',
                        new_position: simulatedPos,
                        diff: 0,
                        reason: "Placed on the list"
                    };
                    virtualHistory.push(generatedLog);
                    break;
                } else if (log.change_type === 'moved') {
                    const oldPos = parseInt(log.old_position, 10);
                    const newPos = parseInt(log.new_position, 10);

                    const diff = oldPos - newPos;

                    generatedLog = {
                        created_at: log.created_at,
                        change_type: 'moved',
                        new_position: newPos,
                        diff: diff,
                        reason: diff > 0 ? "Raised" : "Lowered"
                    };

                    virtualHistory.push(generatedLog);

                    simulatedPos = oldPos;
                    continue;
                }
            }

            const logOldPos = log.old_position ? parseInt(log.old_position, 10) : null;
            const logNewPos = log.new_position ? parseInt(log.new_position, 10) : null;

            if (log.change_type === 'added') {
                if (logNewPos <= simulatedPos) {
                    const diff = -1;
                    generatedLog = {
                        created_at: log.created_at,
                        change_type: 'indirect',
                        new_position: simulatedPos,
                        diff: diff,
                        reason: `**${log.demon_name}** was added above`
                    };
                    virtualHistory.push(generatedLog);
                    simulatedPos -= 1;
                }
            } else if (log.change_type === 'deleted') {
                if (logOldPos <= simulatedPos) {
                    const diff = 1;
                    generatedLog = {
                        created_at: log.created_at,
                        change_type: 'indirect',
                        new_position: simulatedPos,
                        diff: diff,
                        reason: `**${log.demon_name}** was removed above`
                    };
                    virtualHistory.push(generatedLog);
                    simulatedPos += 1;
                }
            } else if (log.change_type === 'moved') {
                let operationalPos = simulatedPos;
                if (logNewPos <= operationalPos) {
                    operationalPos -= 1;
                }
                if (logOldPos <= operationalPos) {
                    operationalPos += 1;
                }

                const positionShift = operationalPos - simulatedPos;

                if (positionShift !== 0) {
                    generatedLog = {
                        created_at: log.created_at,
                        change_type: 'indirect',
                        new_position: simulatedPos,
                        diff: positionShift,
                        reason: positionShift > 0
                            ? `**${log.demon_name}** was moved down past this level`
                            : `**${log.demon_name}** was raised past this level`
                    };
                    virtualHistory.push(generatedLog);
                }

                simulatedPos = operationalPos;
            }
        }

        res.json(virtualHistory);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error reconstructing dynamic history" });
    } finally {
        client.release();
    }
});

app.get('/api/changelog', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const result = await pool.query(`
            SELECT 
                demon_id,
                demon_name, 
                change_type, 
                old_position, 
                new_position, 
                created_at 
            FROM changelog 
            WHERE change_type IN ('added', 'moved', 'deleted') 
              AND list_type = $1
            ORDER BY created_at DESC 
            LIMIT 50
        `, [list]);

        const formattedLogs = result.rows.map(log => {
            return {
                date: log.created_at,
                demonId: log.demon_id,
                demonName: log.demon_name,
                changeType: log.change_type,
                oldPosition: log.old_position,
                newPosition: log.new_position,
            };
        });

        res.json(formattedLogs);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch changelog" });
    }
});

app.get('/api/staff', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, username, display_name, role 
            FROM users 
            WHERE role IN ('owner', 'admin', 'moderator')
            ORDER BY 
                CASE role 
                    WHEN 'owner' THEN 1 
                    WHEN 'admin' THEN 2 
                    WHEN 'moderator' THEN 3 
                END ASC, 
                LOWER(COALESCE(NULLIF(display_name, ''), username)) ASC,
                username ASC
        `);

        const staffRows = result.rows.map(u => ({
            username: u.username,
            displayName: u.display_name || u.username,
            role: u.role
        }));

        const staff = {
            owners: staffRows.filter(u => u.role === 'owner'),
            admins: staffRows.filter(u => u.role === 'admin'),
            moderators: staffRows.filter(u => u.role === 'moderator')
        };

        res.json(staff);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch staff list" });
    }
});

app.get('/api/globalstats', async (req, res) => {
    try {
        const query = `
            SELECT 
                (SELECT COUNT(*) FROM demons) as total_demons,
                (SELECT COUNT(*) FROM records WHERE status = 'accepted') as total_records,
                (
                    SELECT COUNT(DISTINCT u.id) 
                    FROM users u
                    JOIN records r ON u.id = r.user_id
                    JOIN demons d ON r.demon_id = d.id
                    WHERE r.status = 'accepted'
                ) as total_players
        `;

        const result = await pool.query(query);
        const stats = result.rows[0];

        res.json({
            demons: parseInt(stats.total_demons),
            records: parseInt(stats.total_records),
            players: parseInt(stats.total_players)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch global stats" });
    }
});

app.post('/api/submit-verification', async (req, res) => {
    const { name, author, levelId, opinion, videoUrl, enjoymentRating } = req.body;
    const userId = req.session.userId;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const placementOpinion = parseInt(opinion, 10);
    const normalizedEnjoyment = list === 'impossible'
        ? null
        : normalizeEnjoymentRating(enjoymentRating, 100);
    if (!Number.isInteger(placementOpinion) || placementOpinion < 1 || placementOpinion > 150) {
        return res.status(400).json({ error: "You can't submit for the legacy list." });
    }
    if (list !== 'impossible'
        && enjoymentRating !== ''
        && enjoymentRating !== null
        && enjoymentRating !== undefined
        && normalizedEnjoyment === null) {
        return res.status(400).json({ error: "Enjoyment rating must be between 1 and 10." });
    }

    try {
        await pool.query(
            `INSERT INTO verifications
                (user_id, level_name, level_author, level_id, video_url, placement_opinion, list_type, enjoyment_rating)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [userId, name, author, levelId, videoUrl, placementOpinion, list, normalizedEnjoyment]
        );
        res.json({ message: "Verification submitted successfully!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error during submission." });
    }
});


// ---- Clans ---------------------------------------------------------------
const CLAN_NAME_PATTERN = /^[A-Za-z0-9]{1,4}$/;
const CLAN_MAX_MEMBERS = 8;
const CLAN_DESCRIPTION_MAX_LENGTH = 50;
const CLAN_ICON_MAX_BYTES = 100 * 1024;

function normalizeClanName(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeClanDescription(value) {
    return String(value || '').trim().slice(0, CLAN_DESCRIPTION_MAX_LENGTH);
}

function parseClanIconDataUrl(value) {
    const match = String(value || '').match(/^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) return null;

    let data;
    try {
        data = Buffer.from(match[2], 'base64');
    } catch (_) {
        return null;
    }

    if (!data.length || data.length > CLAN_ICON_MAX_BYTES) return null;
    return { data, mimeType: match[1].toLowerCase() };
}

function parseClanArray(value) {
    return Array.isArray(value) ? value : [];
}

function formatClanDisplayName(displayName, clanName) {
    const base = String(displayName || '').trim();
    const clan = String(clanName || '').trim();
    return clan ? `[${clan}] ${base}` : base;
}

async function getClanTagsForUsers(db, userIds) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : [])
        .map(value => Number.parseInt(value, 10))
        .filter(Number.isInteger))];
    if (!ids.length) return new Map();

    const result = await db.query(`
        SELECT
            (member->>'userId')::integer AS user_id,
            c.name AS clan_name
        FROM clans c
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.members, '[]'::jsonb)) AS member
        WHERE (member->>'userId')::integer = ANY($1::integer[])
    `, [ids]);

    return new Map(result.rows.map(row => [Number(row.user_id), row.clan_name]));
}

async function getClanViewerMembership(db, userId) {
    const id = Number.parseInt(userId, 10);
    if (!Number.isInteger(id)) return null;

    const result = await db.query(`
        SELECT
            c.id AS clan_id,
            member->>'role' AS role
        FROM clans c
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.members, '[]'::jsonb)) AS member
        WHERE (member->>'userId')::integer = $1
        LIMIT 1
    `, [id]);
    return result.rows[0] || null;
}

async function deleteClanApplicationsForUser(db, userId, { excludeClanId = null } = {}) {
    const id = Number.parseInt(userId, 10);
    if (!Number.isInteger(id)) return;

    const excludedId = Number.parseInt(excludeClanId, 10);
    const hasExcludedClan = Number.isInteger(excludedId);
    const values = hasExcludedClan ? [id, excludedId] : [id];
    const excludedClanSql = hasExcludedClan ? 'AND c.id <> $2' : '';

    await db.query(`
        UPDATE clans c
        SET applications = COALESCE((
            SELECT jsonb_agg(entry)
            FROM jsonb_array_elements(COALESCE(c.applications, '[]'::jsonb)) AS entry
            WHERE (entry->>'userId')::integer <> $1
        ), '[]'::jsonb)
        WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(c.applications, '[]'::jsonb)) AS application
            WHERE (application->>'userId')::integer = $1
        )
        ${excludedClanSql}
    `, values);
}

async function requireClanManager(db, clanId, userId, { ownerOnly = false } = {}) {
    const result = await db.query(`
        SELECT
            c.id,
            c.name,
            c.owner_user_id,
            c.members,
            c.applications,
            member->>'role' AS role,
            COALESCE(NULLIF(actor.display_name, ''), actor.username, 'WBDL') AS actor_name
        FROM clans c
        LEFT JOIN users actor ON actor.id = $2
        LEFT JOIN LATERAL (
            SELECT value AS member
            FROM jsonb_array_elements(COALESCE(c.members, '[]'::jsonb)) AS value
            WHERE (value->>'userId')::integer = $2
            LIMIT 1
        ) membership ON TRUE
        WHERE c.id = $1
    `, [clanId, userId]);

    const row = result.rows[0];
    if (!row) return { error: 'Clan not found.', status: 404 };
    const allowed = ownerOnly ? row.role === 'owner' : ['owner', 'manager'].includes(row.role);
    if (!allowed) return { error: 'You do not have permission to manage this clan.', status: 403 };
    return { clan: row };
}

function clanIconUrl(id, updatedAt) {
    const version = updatedAt ? new Date(updatedAt).getTime() : Date.now();
    return `/api/clans/${id}/icon?v=${Number.isFinite(version) ? version : Date.now()}`;
}

app.get('/api/clans', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const result = await pool.query(`
            WITH player_points AS (
                SELECT
                    u.id AS user_id,
                    SUM(
                        CASE
                            WHEN d.position > 150 THEN 0
                            WHEN $1 = 'impossible' THEN
                                (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                            ELSE
                                CASE
                                    WHEN r.percentage = 100 THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                    WHEN d.position <= 75 AND r.percentage >= d.requirement THEN
                                        (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                    ELSE 0
                                END
                        END
                    ) AS total_points
                FROM users u
                JOIN records r ON r.user_id = u.id
                JOIN demons d ON d.id = r.demon_id
                WHERE r.status = 'accepted'
                  AND r.list_type = $1
                  AND d.list_type = $1
                  AND COALESCE(u.leaderboard_banned, FALSE) = FALSE
                  AND COALESCE(u.account_disabled, FALSE) = FALSE
                GROUP BY u.id
            ), clan_scores AS (
                SELECT
                    c.id,
                    c.name,
                    c.description,
                    c.created_at,
                    c.updated_at,
                    jsonb_array_length(COALESCE(c.members, '[]'::jsonb))::int AS member_count,
                    COALESCE(SUM(pp.total_points), 0) AS total_points
                FROM clans c
                LEFT JOIN LATERAL jsonb_array_elements(COALESCE(c.members, '[]'::jsonb)) AS member ON TRUE
                LEFT JOIN player_points pp ON pp.user_id = (member->>'userId')::integer
                GROUP BY c.id
            ), ranked AS (
                SELECT *, RANK() OVER (ORDER BY total_points DESC) AS rank
                FROM clan_scores
            )
            SELECT *
            FROM ranked
            ORDER BY total_points DESC, created_at ASC, id ASC
        `, [list]);

        const membership = await getClanViewerMembership(pool, req.session?.userId);
        res.json({
            loggedIn: Boolean(req.session?.userId),
            myClanId: membership ? Number(membership.clan_id) : null,
            clans: result.rows.map(row => ({
                id: Number(row.id),
                name: row.name,
                description: row.description || '',
                memberCount: Number(row.member_count) || 0,
                totalPoints: Number(row.total_points || 0).toFixed(2),
                rank: Number(row.rank) || 0,
                iconUrl: clanIconUrl(row.id, row.updated_at),
            })),
        });
    } catch (err) {
        console.error('Clan leaderboard error:', err);
        res.status(500).json({ error: 'Could not load clans.' });
    }
});

app.get('/api/clans/:clanId/icon', async (req, res) => {
    const clanId = Number.parseInt(req.params.clanId, 10);
    if (!Number.isInteger(clanId)) return res.sendStatus(404);

    try {
        const result = await pool.query(
            'SELECT icon_data, icon_mime, updated_at FROM clans WHERE id = $1',
            [clanId]
        );
        const clan = result.rows[0];
        if (!clan?.icon_data) return res.sendStatus(404);

        res.set('Content-Type', clan.icon_mime || 'image/webp');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(clan.icon_data);
    } catch (err) {
        console.error('Clan icon error:', err);
        res.sendStatus(500);
    }
});

app.get('/api/clans/:clanId', async (req, res) => {
    const clanId = Number.parseInt(req.params.clanId, 10);
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';
    if (!Number.isInteger(clanId)) return res.status(400).json({ error: 'Invalid clan.' });

    try {
        const clanResult = await pool.query(`
            WITH player_points AS (
                SELECT
                    u.id AS user_id,
                    SUM(
                        CASE
                            WHEN d.position > 150 THEN 0
                            WHEN $1 = 'impossible' THEN
                                (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                            ELSE
                                CASE
                                    WHEN r.percentage = 100 THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                    WHEN d.position <= 75 AND r.percentage >= d.requirement THEN
                                        (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                    ELSE 0
                                END
                        END
                    ) AS total_points
                FROM users u
                JOIN records r ON r.user_id = u.id
                JOIN demons d ON d.id = r.demon_id
                WHERE r.status = 'accepted'
                  AND r.list_type = $1
                  AND d.list_type = $1
                  AND COALESCE(u.leaderboard_banned, FALSE) = FALSE
                  AND COALESCE(u.account_disabled, FALSE) = FALSE
                GROUP BY u.id
            ), clan_scores AS (
                SELECT
                    c.id,
                    c.name,
                    c.description,
                    c.owner_user_id,
                    c.created_at,
                    c.updated_at,
                    c.members,
                    c.applications,
                    jsonb_array_length(COALESCE(c.members, '[]'::jsonb))::int AS member_count,
                    COALESCE(SUM(pp.total_points), 0) AS total_points
                FROM clans c
                LEFT JOIN LATERAL jsonb_array_elements(COALESCE(c.members, '[]'::jsonb)) AS member ON TRUE
                LEFT JOIN player_points pp ON pp.user_id = (member->>'userId')::integer
                GROUP BY c.id
            ), ranked AS (
                SELECT *, RANK() OVER (ORDER BY total_points DESC) AS rank
                FROM clan_scores
            )
            SELECT * FROM ranked WHERE id = $2
        `, [list, clanId]);

        const clan = clanResult.rows[0];
        if (!clan) return res.status(404).json({ error: 'Clan not found.' });

        const membersResult = await pool.query(`
            WITH player_points AS (
                SELECT
                    u.id AS user_id,
                    SUM(
                        CASE
                            WHEN d.position > 150 THEN 0
                            WHEN $1 = 'impossible' THEN
                                (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                            ELSE
                                CASE
                                    WHEN r.percentage = 100 THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                    WHEN d.position <= 75 AND r.percentage >= d.requirement THEN
                                        (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                    ELSE 0
                                END
                        END
                    ) AS total_points
                FROM users u
                JOIN records r ON r.user_id = u.id
                JOIN demons d ON d.id = r.demon_id
                WHERE r.status = 'accepted'
                  AND r.list_type = $1
                  AND d.list_type = $1
                  AND COALESCE(u.leaderboard_banned, FALSE) = FALSE
                  AND COALESCE(u.account_disabled, FALSE) = FALSE
                GROUP BY u.id
            )
            SELECT
                u.id,
                u.username,
                u.display_name,
                u.role AS site_role,
                u.icon_type,
                u.icon_id,
                u.color1,
                u.color2,
                u.glow,
                member->>'role' AS clan_role,
                member->>'joinedAt' AS joined_at,
                COALESCE(pp.total_points, 0) AS total_points
            FROM clans c
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.members, '[]'::jsonb)) AS member
            JOIN users u ON u.id = (member->>'userId')::integer
            LEFT JOIN player_points pp ON pp.user_id = u.id
            WHERE c.id = $2
            ORDER BY
                CASE member->>'role' WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
                COALESCE(pp.total_points, 0) DESC,
                LOWER(u.username) ASC
        `, [list, clanId]);

        const viewerMembership = await getClanViewerMembership(pool, req.session?.userId);
        const viewerRole = viewerMembership && Number(viewerMembership.clan_id) === clanId
            ? viewerMembership.role
            : null;
        const canManage = ['owner', 'manager'].includes(viewerRole);

        const storedApplications = parseClanArray(clan.applications);
        const application = req.session?.userId
            ? storedApplications.find(entry => Number(entry?.userId) === Number(req.session.userId) && entry?.status === 'pending') || null
            : null;

        let applications = [];
        if (canManage) {
            const pending = storedApplications.filter(entry => entry?.status === 'pending');
            const pendingUserIds = [...new Set(pending.map(entry => Number(entry?.userId)).filter(Number.isInteger))];
            let usersById = new Map();

            if (pendingUserIds.length) {
                const applicationUsersResult = await pool.query(`
                    SELECT
                        id,
                        username,
                        display_name,
                        icon_type,
                        icon_id,
                        color1,
                        color2,
                        glow
                    FROM users
                    WHERE id = ANY($1::integer[])
                `, [pendingUserIds]);
                usersById = new Map(applicationUsersResult.rows.map(row => [Number(row.id), row]));
            }

            applications = pending
                .map(entry => ({ entry, user: usersById.get(Number(entry.userId)) }))
                .filter(item => item.user)
                .map(({ entry, user }) => ({
                    id: String(entry.id),
                    created_at: entry.createdAt || null,
                    user_id: Number(user.id),
                    username: user.username,
                    display_name: user.display_name,
                    icon_type: user.icon_type,
                    icon_id: user.icon_id,
                    color1: user.color1,
                    color2: user.color2,
                    glow: user.glow,
                }));
        }

        const serializeIcon = row => ({
            type: row.icon_type || 'cube',
            id: readProfileInt(row.icon_id, 1),
            color1: readProfileInt(row.color1, 12),
            color2: readProfileInt(row.color2, 3),
            glow: readProfileInt(row.glow, -1),
        });

        res.json({
            clan: {
                id: Number(clan.id),
                name: clan.name,
                description: clan.description || '',
                memberCount: Number(clan.member_count) || 0,
                totalPoints: Number(clan.total_points || 0).toFixed(2),
                rank: Number(clan.rank) || 0,
                iconUrl: clanIconUrl(clan.id, clan.updated_at),
            },
            members: membersResult.rows.map(row => ({
                id: Number(row.id),
                username: row.username,
                displayName: row.display_name || row.username,
                siteRole: row.site_role || '',
                clanRole: row.clan_role,
                totalPoints: Number(row.total_points || 0).toFixed(2),
                icon: serializeIcon(row),
            })),
            viewer: {
                loggedIn: Boolean(req.session?.userId),
                myClanId: viewerMembership ? Number(viewerMembership.clan_id) : null,
                role: viewerRole,
                canManage,
                isOwner: viewerRole === 'owner',
                canApply: Boolean(req.session?.userId)
                    && !viewerMembership
                    && Number(clan.member_count) < CLAN_MAX_MEMBERS
                    && !application,
                application: application ? { id: String(application.id), status: application.status } : null,
            },
            management: canManage ? {
                applications: applications.map(row => ({
                    id: String(row.id),
                    userId: Number(row.user_id),
                    username: row.username,
                    displayName: row.display_name || row.username,
                    icon: serializeIcon(row),
                })),
            } : null,
        });
    } catch (err) {
        console.error('Clan detail error:', err);
        res.status(500).json({ error: 'Could not load this clan.' });
    }
});

app.post('/api/clans', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });

    const name = normalizeClanName(req.body?.name);
    const description = normalizeClanDescription(req.body?.description);
    const icon = parseClanIconDataUrl(req.body?.iconDataUrl);

    if (!CLAN_NAME_PATTERN.test(name)) return res.status(400).json({ error: 'Clan names must be 1–4 letters or numbers.' });
    if (!icon) return res.status(400).json({ error: 'Please upload a valid clan icon.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE clans IN SHARE ROW EXCLUSIVE MODE');

        const membership = await getClanViewerMembership(client, req.session.userId);
        if (membership) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'You are already in a clan.' });
        }

        const joinedAt = new Date().toISOString();
        const members = [{ userId: Number(req.session.userId), role: 'owner', joinedAt }];
        const clanResult = await client.query(`
            INSERT INTO clans (name, description, icon_data, icon_mime, owner_user_id, members, applications)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb)
            RETURNING id
        `, [name, description, icon.data, icon.mimeType, req.session.userId, JSON.stringify(members)]);

        await deleteClanApplicationsForUser(client, req.session.userId, {
            excludeClanId: Number(clanResult.rows[0].id),
        });

        await client.query('COMMIT');
        res.status(201).json({ message: 'Clan created!', clanId: Number(clanResult.rows[0].id) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') {
            return res.status(400).json({ error: 'That clan name is already taken, or you are already in a clan.' });
        }
        console.error('Clan creation error:', err);
        res.status(500).json({ error: 'Could not create the clan.' });
    } finally {
        client.release();
    }
});

app.patch('/api/clans/:clanId', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    if (!Number.isInteger(clanId)) return res.status(400).json({ error: 'Invalid clan.' });

    try {
        const permission = await requireClanManager(pool, clanId, req.session.userId);
        if (permission.error) return res.status(permission.status).json({ error: permission.error });

        const updates = [];
        const values = [];
        const add = (sql, value) => {
            values.push(value);
            updates.push(`${sql} = $${values.length}`);
        };

        if (req.body?.name !== undefined) {
            const name = normalizeClanName(req.body.name);
            if (!CLAN_NAME_PATTERN.test(name)) return res.status(400).json({ error: 'Clan names must be 1–4 letters or numbers.' });
            add('name', name);
        }
        if (req.body?.description !== undefined) add('description', normalizeClanDescription(req.body.description));
        if (req.body?.iconDataUrl) {
            const icon = parseClanIconDataUrl(req.body.iconDataUrl);
            if (!icon) return res.status(400).json({ error: 'Please upload a valid clan icon.' });
            add('icon_data', icon.data);
            add('icon_mime', icon.mimeType);
        }
        if (!updates.length) return res.json({ message: 'Nothing changed.' });

        values.push(clanId);
        await pool.query(`
            UPDATE clans
            SET ${updates.join(', ')}
            WHERE id = $${values.length}
        `, values);
        res.json({ message: 'Clan updated.' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'That clan name is already taken.' });
        console.error('Clan update error:', err);
        res.status(500).json({ error: 'Could not update the clan.' });
    }
});

app.delete('/api/clans/:clanId', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    if (!Number.isInteger(clanId)) return res.status(400).json({ error: 'Invalid clan.' });

    try {
        const permission = await requireClanManager(pool, clanId, req.session.userId, { ownerOnly: true });
        if (permission.error) return res.status(permission.status).json({ error: permission.error });
        await pool.query('DELETE FROM clans WHERE id = $1', [clanId]);
        res.json({ message: 'Clan deleted.' });
    } catch (err) {
        console.error('Clan delete error:', err);
        res.status(500).json({ error: 'Could not delete the clan.' });
    }
});

app.post('/api/clans/:clanId/applications', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    if (!Number.isInteger(clanId)) return res.status(400).json({ error: 'Invalid clan.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE clans IN SHARE ROW EXCLUSIVE MODE');
        const clanResult = await client.query(`
            SELECT id, members, applications
            FROM clans
            WHERE id = $1
            FOR UPDATE
        `, [clanId]);
        const clan = clanResult.rows[0];
        if (!clan) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Clan not found.' });
        }

        const members = parseClanArray(clan.members);
        if (members.length >= CLAN_MAX_MEMBERS) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'This clan is full.' });
        }

        const membership = await getClanViewerMembership(client, req.session.userId);
        if (membership) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'You are already in a clan.' });
        }

        const applications = parseClanArray(clan.applications);
        if (applications.some(entry => Number(entry?.userId) === Number(req.session.userId) && entry?.status === 'pending')) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'You already applied to this clan.' });
        }

        const applicationId = randomBytes(8).toString('hex');
        applications.push({
            id: applicationId,
            userId: Number(req.session.userId),
            status: 'pending',
            createdAt: new Date().toISOString(),
            respondedAt: null,
            respondedByUserId: null,
        });

        await client.query('UPDATE clans SET applications = $2::jsonb WHERE id = $1', [clanId, JSON.stringify(applications)]);
        await client.query('COMMIT');
        res.status(201).json({ message: 'Application sent.', applicationId });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Clan application error:', err);
        res.status(500).json({ error: 'Could not submit the application.' });
    } finally {
        client.release();
    }
});

app.post('/api/clans/:clanId/applications/:applicationId/respond', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    const applicationId = String(req.params.applicationId || '').trim();
    const action = String(req.body?.action || '').toLowerCase();
    if (!Number.isInteger(clanId) || !/^[A-Za-z0-9_-]{1,64}$/.test(applicationId) || !['accept', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid request.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE clans IN SHARE ROW EXCLUSIVE MODE');
        const permission = await requireClanManager(client, clanId, req.session.userId);
        if (permission.error) {
            await client.query('ROLLBACK');
            return res.status(permission.status).json({ error: permission.error });
        }

        const clanResult = await client.query(`
            SELECT id, name, members, applications
            FROM clans
            WHERE id = $1
            FOR UPDATE
        `, [clanId]);
        const clan = clanResult.rows[0];
        const members = parseClanArray(clan.members);
        const applications = parseClanArray(clan.applications);
        const application = applications.find(entry => String(entry?.id) === applicationId);

        if (!application || application.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Pending application not found.' });
        }

        const respondedAt = new Date().toISOString();
        if (action === 'accept') {
            if (members.length >= CLAN_MAX_MEMBERS) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'This clan is full.' });
            }

            const membership = await getClanViewerMembership(client, application.userId);
            if (membership) {
                application.status = 'rejected';
                application.respondedAt = respondedAt;
                application.respondedByUserId = Number(req.session.userId);
                await client.query('UPDATE clans SET applications = $2::jsonb WHERE id = $1', [clanId, JSON.stringify(applications)]);
                await client.query('COMMIT');
                return res.status(400).json({ error: 'That user already joined another clan.' });
            }

            members.push({
                userId: Number(application.userId),
                role: 'member',
                joinedAt: respondedAt,
            });
            application.status = 'accepted';
            application.respondedAt = respondedAt;
            application.respondedByUserId = Number(req.session.userId);

            await client.query(`
                UPDATE clans
                SET members = $2::jsonb,
                    applications = $3::jsonb
                WHERE id = $1
            `, [clanId, JSON.stringify(members), JSON.stringify(applications)]);

            await deleteClanApplicationsForUser(client, application.userId, {
                excludeClanId: clanId,
            });

            await createInboxNotification(client, {
                userId: application.userId,
                actorId: req.session.userId,
                type: 'message',
                subject: `Clan application accepted: [${clan.name}]`,
                body: `Your application to join **[${clan.name}]** was accepted. Welcome to the clan!`,
                senderName: permission.clan.actor_name,
            });
        } else {
            application.status = 'rejected';
            application.respondedAt = respondedAt;
            application.respondedByUserId = Number(req.session.userId);
            await client.query('UPDATE clans SET applications = $2::jsonb WHERE id = $1', [clanId, JSON.stringify(applications)]);
            await createInboxNotification(client, {
                userId: application.userId,
                actorId: req.session.userId,
                type: 'message',
                subject: `Clan application rejected: [${clan.name}]`,
                body: `Your application to join **[${clan.name}]** was rejected.`,
                senderName: permission.clan.actor_name,
            });
        }

        await client.query('COMMIT');
        res.json({ message: action === 'accept' ? 'Application accepted.' : 'Application rejected.' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Clan application response error:', err);
        res.status(500).json({ error: 'Could not process the application.' });
    } finally {
        client.release();
    }
});

app.patch('/api/clans/:clanId/members/:userId/role', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    const userId = Number.parseInt(req.params.userId, 10);
    const role = String(req.body?.role || '').toLowerCase();
    if (!Number.isInteger(clanId) || !Number.isInteger(userId) || !['manager', 'member'].includes(role)) {
        return res.status(400).json({ error: 'Invalid request.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const permission = await requireClanManager(client, clanId, req.session.userId);
        if (permission.error) {
            await client.query('ROLLBACK');
            return res.status(permission.status).json({ error: permission.error });
        }

        const clanResult = await client.query('SELECT name, members FROM clans WHERE id = $1 FOR UPDATE', [clanId]);
        const clan = clanResult.rows[0];
        const members = parseClanArray(clan.members);
        const target = members.find(member => Number(member?.userId) === userId);
        if (!target || target.role === 'owner') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'That member cannot be changed.' });
        }

        if (role === 'manager') {
            for (const member of members) {
                if (member.role === 'manager') member.role = 'member';
            }
        }
        target.role = role;

        await client.query('UPDATE clans SET members = $2::jsonb WHERE id = $1', [clanId, JSON.stringify(members)]);
        await createInboxNotification(client, {
            userId,
            actorId: req.session.userId,
            type: 'message',
            subject: role === 'manager' ? `You are now the manager of [${clan.name}]` : `You are no longer the manager of [${clan.name}]`,
            body: role === 'manager'
                ? `You were made the manager of **[${clan.name}]**.`
                : `Your manager role in **[${clan.name}]** was removed.`,
            senderName: permission.clan.actor_name,
        });
        await client.query('COMMIT');
        res.json({ message: role === 'manager' ? 'Manager assigned.' : 'Manager removed.' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Clan role error:', err);
        res.status(500).json({ error: 'Could not change the clan role.' });
    } finally {
        client.release();
    }
});

app.delete('/api/clans/:clanId/members/:userId', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isInteger(clanId) || !Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid request.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const permission = await requireClanManager(client, clanId, req.session.userId);
        if (permission.error) {
            await client.query('ROLLBACK');
            return res.status(permission.status).json({ error: permission.error });
        }

        const clanResult = await client.query('SELECT name, members FROM clans WHERE id = $1 FOR UPDATE', [clanId]);
        const clan = clanResult.rows[0];
        const members = parseClanArray(clan.members);
        const target = members.find(member => Number(member?.userId) === userId);
        if (!target) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Member not found.' });
        }
        if (target.role === 'owner') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'The clan owner cannot be removed.' });
        }
        if (permission.clan.role === 'manager' && target.role !== 'member') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Managers can only remove regular members.' });
        }

        const userResult = await client.query('SELECT username FROM users WHERE id = $1', [userId]);
        const username = userResult.rows[0]?.username || 'User';
        const updatedMembers = members.filter(member => Number(member?.userId) !== userId);
        await client.query('UPDATE clans SET members = $2::jsonb WHERE id = $1', [clanId, JSON.stringify(updatedMembers)]);
        await createInboxNotification(client, {
            userId,
            actorId: req.session.userId,
            type: 'message',
            subject: `Removed from [${clan.name}]`,
            body: `You were removed from **[${clan.name}]**.`,
            senderName: `[${clan.name}]`,
        });
        await client.query('COMMIT');
        res.json({ message: `${username} was removed.` });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Clan member removal error:', err);
        res.status(500).json({ error: 'Could not remove the member.' });
    } finally {
        client.release();
    }
});

app.post('/api/clans/:clanId/leave', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'You must be logged in.' });
    const clanId = Number.parseInt(req.params.clanId, 10);
    if (!Number.isInteger(clanId)) return res.status(400).json({ error: 'Invalid clan.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const clanResult = await client.query('SELECT members FROM clans WHERE id = $1 FOR UPDATE', [clanId]);
        const clan = clanResult.rows[0];
        if (!clan) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Clan not found.' });
        }

        const members = parseClanArray(clan.members);
        const membership = members.find(member => Number(member?.userId) === Number(req.session.userId));
        if (!membership) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'You are not in this clan.' });
        }
        if (membership.role === 'owner') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'The owner must delete the clan instead.' });
        }

        const updatedMembers = members.filter(member => Number(member?.userId) !== Number(req.session.userId));
        await client.query('UPDATE clans SET members = $2::jsonb WHERE id = $1', [clanId, JSON.stringify(updatedMembers)]);
        await client.query('COMMIT');
        res.json({ message: 'You left the clan.' });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Clan leave error:', err);
        res.status(500).json({ error: 'Could not leave the clan.' });
    } finally {
        client.release();
    }
});


app.post('/api/forgot-password', async (req, res) => {
    const { email, captchaToken } = req.body;

    if (!captchaToken) {
        return res.status(400).json({ error: "bro is a bot" });
    }

    const SECRET_KEY = process.env.RECAPTCHA_SECRET;

    try {
        const params = new URLSearchParams();
        params.append('secret', SECRET_KEY);
        params.append('response', captchaToken);

        const googleRes = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            params
        );

        if (!googleRes.data.success) {
            return res.status(400).json({ error: "bro is a bot" });
        }
    } catch (err) {
        console.error("Captcha Error:", err);
        return res.status(500).json({ error: "Error verifying CAPTCHA." });
    }

    try {
        const user = await pool.query('SELECT id, username FROM users WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            return res.json({ message: "Reset link sent!" }); // Not really, the account doesnt exist LMAO
        }

        const token = randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000);

        await pool.query(
            'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
            [token, expires, email]
        );

        const link = `https://webdemonlist.org/reset-password?token=${token}`;
        await sendResetEmail(email, user.rows[0].username, link);

        res.json({ message: "Reset link sent!" });
    } catch (err) {
        res.status(500).json({ error: "Error processing request" });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    try {
        const user = await pool.query(
            'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
            [token]
        );

        if (user.rows.length === 0) return res.status(400).json({ error: "Invalid or expired token." });

        const hashedPw = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
            [hashedPw, user.rows[0].id]
        );

        res.json({ message: "Password updated successfully!" });
    } catch (err) {
        res.status(500).json({ error: "Error resetting password" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));