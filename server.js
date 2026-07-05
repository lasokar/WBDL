const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
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
    socialLinks: {
        youtube: user.social_youtube || '',
        twitter: user.social_twitter || '',
        twitch: user.social_twitch || '',
        discord: user.social_discord || '',
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
             SELECT 1 FROM pending_users WHERE LOWER(email) = LOWER($1)`,
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
    const { token } = req.query;

    try {
        const pending = await pool.query('SELECT * FROM pending_users WHERE token = $1', [token]);

        if (pending.rows.length === 0) {
            return res.status(400).send("This link is invalid or has already been used.");
        }

        const user = pending.rows[0];

        await pool.query(
            'INSERT INTO users (username, password_hash, email) VALUES ($1, $2, $3)',
            [user.username, user.password_hash, user.email]
        );

        await pool.query('DELETE FROM pending_users WHERE token = $1', [token]);

        res.status(200).send("Success");
    } catch (err) {
        console.error(err);
        res.status(500).send("Internal server error during verification.");
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const userResult = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    
    if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (validPassword) {
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
                'SELECT username, role, display_name, icon_type, icon_id, color1, color2, glow FROM users WHERE id = $1', 
                [req.session.userId]
            );

            if (user.rows.length > 0) {
                const userData = user.rows[0];
                res.json({ 
                    loggedIn: true, 
                    username: userData.username, 
                    role: userData.role,
                    displayName: userData.display_name || '',
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

    const { demonId, percentage, videoUrl } = req.body;
    const newPercent = parseInt(percentage);
    
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (isNaN(newPercent) || newPercent <= 0) {
        return res.status(400).json({ error: "Percentage must be a valid number greater than 0%." });
    }

    if (newPercent > 100) {
        return res.status(400).json({ error: "Percentage cannot be higher than 100%." });
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
                 SET percentage = $1, video_url = $2, status = 'pending' 
                 WHERE id = $3`,
                [newPercent, videoUrl, existingRecord.rows[0].id]
            );
            return res.json({ message: "Record updated and awaiting review!" });
        }

        await pool.query(
            'INSERT INTO records (user_id, demon_id, percentage, video_url, list_type, status) VALUES ($1, $2, $3, $4, $5, \'pending\')',
            [req.session.userId, demonId, newPercent, videoUrl, list]
        );
        
        res.json({ message: "Record submitted successfully!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error." });
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

    try {
        await pool.query('BEGIN');

        const actorQuery = await pool.query('SELECT role FROM users WHERE id = $1', [actorId]);
        const actorRole = actorQuery.rows[0]?.role;

        const recordQuery = await pool.query('SELECT user_id, list_type FROM records WHERE id = $1', [recordId]);
        
        if (recordQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: "Record not found" });
        }

        const { user_id: recordOwnerId, list_type } = recordQuery.rows[0];

        if (list_type !== activeSubdomainList) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: "This record does not belong to the active list layout configuration." });
        }

        if (recordOwnerId === actorId && actorRole === 'moderator') {
            await pool.query('ROLLBACK');
            return res.status(403).json({ error: "You cannot verify your own record!" });
        }

        const result = await pool.query(
            'UPDATE records SET status = $1 WHERE id = $2 RETURNING user_id', 
            [status, recordId]
        );

        const targetUserId = result.rows[0].user_id;

        await pool.query(
            `INSERT INTO notifications (user_id, actor_id, record_id, type, reason, list_type) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [targetUserId, actorId, recordId, status, reason || null, list_type]
        );

        await pool.query('COMMIT');
        res.json({ message: `Record ${status}.` });

    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Failed to update record" });
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

    try {
        await pool.query('BEGIN');

        const verifQuery = await pool.query(
            'SELECT user_id, level_name, list_type FROM verifications WHERE id = $1', 
            [verifId]
        );
        
        if (verifQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: "Verification not found" });
        }
        
        const { user_id, level_name, list_type } = verifQuery.rows[0];

        if (list_type !== activeSubdomainList) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: "This request does not belong to the active list layout configuration." });
        }

        await pool.query(
            'UPDATE verifications SET status = $1, rejection_reason = $2 WHERE id = $3',
            ['rejected', reason || null, verifId]
        );

        await pool.query(
            `INSERT INTO notifications (user_id, actor_id, type, reason, custom_text, record_id, list_type) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                user_id, 
                actorId, 
                'verif_rejected', 
                reason || "Level did not meet requirements.", 
                level_name,
                null,
                list_type
            ]
        );

        await pool.query('COMMIT');
        res.json({ message: "Verification rejected." });
    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error("Rejection error:", err);
        res.status(500).json({ error: "Failed to reject verification: " + err.message });
    }
});

app.post('/api/admin/approve-verification', isAdmin, async (req, res) => {
    const { verifId, demonId } = req.body;
    const actorId = req.session.userId;
    
    const activeSubdomainList = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        await pool.query('BEGIN');
        const actorQuery = await pool.query('SELECT role FROM users WHERE id = $1', [actorId]);
        const actorRole = actorQuery.rows[0]?.role;

        const verifQuery = await pool.query(
            'SELECT user_id, video_url, list_type FROM verifications WHERE id = $1', 
            [verifId]
        );
        
        if (verifQuery.rows.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ error: "Verification data missing" });
        }

        const { user_id, video_url, list_type } = verifQuery.rows[0];

        if (list_type !== activeSubdomainList) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: "This request does not belong to the active list layout configuration." });
        }

        if (user_id === actorId && actorRole === 'admin') {
            await pool.query('ROLLBACK');
            return res.status(403).json({ error: "Admins cannot approve their own level verifications!" });
        }

        await pool.query('UPDATE verifications SET status = $1 WHERE id = $2', ['accepted', verifId]);

        if (list_type === 'impossible') {
            await pool.query(
                'UPDATE demons SET showcase_url = $1 WHERE id = $2',
                [video_url, demonId]
            );

            await pool.query(
                `INSERT INTO notifications (user_id, actor_id, record_id, type, list_type) 
                 VALUES ($1, $2, null, $3, $4)`,
                [user_id, actorId, 'verif_accepted', list_type]
            );
        } else {
            const recordPercentage = 100;

            const newRecord = await pool.query(
                `INSERT INTO records (user_id, demon_id, percentage, video_url, status, list_type) 
                 VALUES ($1, $2, $3, $4, 'accepted', $5) RETURNING id`,
                [user_id, demonId, recordPercentage, video_url, list_type]
            );

            await pool.query(
                `INSERT INTO notifications (user_id, actor_id, record_id, type, list_type) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [user_id, actorId, newRecord.rows[0].id, 'verif_accepted', list_type]
            );
        }

        await pool.query('COMMIT');
        res.json({ message: "Level verified and record added to list." });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Failed to finalize verification" });
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
                    social_youtube, social_twitter, social_twitch, social_discord, social_reddit, social_gdbrowser,
                    icon_type, icon_id, color1, color2, glow
             FROM users WHERE username = $1`, 
            [username]
        );
        
        if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
        
        const user = userResult.rows[0];

        const recordsResult = await pool.query(`
            SELECT 
                r.id AS record_id,
                r.percentage, 
                r.video_url, 
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
            WHERE r.user_id = $1 AND r.status = 'accepted' AND r.list_type = $2 AND d.list_type = $2
            ORDER BY d.position ASC
        `, [user.id, list]);

        const recordsWithPoints = recordsResult.rows.map(r => {
            const basePoints = 250 * Math.exp(-0.0263 * (r.position - 1));
            let awardedPoints = 0;

            if (r.position > 150) {
                awardedPoints = 0;
            } else if (list === 'impossible') {
                awardedPoints = basePoints * (r.percentage / 100);
            } else {
                if (r.percentage === 100) {
                    awardedPoints = basePoints;
                } else if (r.position <= 75 && r.percentage >= r.requirement) {
                    awardedPoints = basePoints / 10;
                } else {
                    awardedPoints = 0;
                }
            }

            return { 
                ...r, 
                points: awardedPoints.toFixed(2),
                record_id: r.record_id,
            };
        });

        const totalPoints = recordsWithPoints.reduce((sum, r) => sum + parseFloat(r.points), 0).toFixed(2);

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
                                    WHEN r.percentage = 100 THEN 
                                        (250 * EXP(-0.0263 * (d.position - 1)))

                                    WHEN d.position <= 75 AND r.percentage >= d.requirement THEN 
                                        (250 * EXP(-0.0263 * (d.position - 1))) / 10

                                    ELSE 0 
                                END
                        END
                    ) as total_score
                FROM users u
                JOIN records r ON u.id = r.user_id
                JOIN demons d ON r.demon_id = d.id
                WHERE r.status = 'accepted' 
                AND r.list_type = $2 
                AND d.list_type = $2
                GROUP BY u.id
            ),
            RankedPlayers AS (
                SELECT 
                    id, 
                    total_score, 
                    RANK() OVER (ORDER BY total_score DESC) as rank
                FROM Leaderboard
                WHERE total_score > 0
            )
            SELECT rank FROM RankedPlayers WHERE id = $1;
        `, [user.id, list]);

        const leaderboardRank = rankResult.rows.length > 0 ? rankResult.rows[0].rank : 0;

        res.json({
            username: user.username,
            joined: user.created_at,
            totalPoints,
            leaderboardRank,
            records: recordsWithPoints,
            role: user.role,
            userId: user.id,
            ...serializeProfileUser(user),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const query = `
            WITH PlayerStats AS (
                SELECT 
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
                WHERE r.status = 'accepted' AND r.list_type = $1 AND d.list_type = $1
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
        
        const leaderboard = result.rows.map(row => ({
            ...row,
            displayName: row.display_name || row.username,
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

        const formattedRecords = recordsResult.rows.map(row => ({
            ...row,
            displayName: row.display_name || row.username,
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
            SELECT username,
                   display_name, bio, pronouns, country,
                   social_youtube, social_twitter, social_twitch, social_discord, social_reddit, social_gdbrowser,
                   icon_type, icon_id, color1, color2, glow
            FROM users
            WHERE id = $1
        `, [req.session.userId]);

        if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });

        const user = userResult.rows[0];
        res.json({
            username: user.username,
            ...serializeProfileUser(user),
        });
    } catch (err) {
        console.error("Profile settings load error:", err);
        res.status(500).json({ error: "Server error." });
    }
});

app.post('/api/settings/profile', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const socialLinks = req.body.socialLinks || {};
    const icon = cleanProfileIcon(req.body.icon || {});

    const profile = {
        displayName: cleanProfileText(req.body.displayName, 40),
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

    try {
        const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
        const user = userRes.rows[0];

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: "Incorrect password. Account was not deleted." });
        }

        await pool.query('BEGIN');
        await pool.query('DELETE FROM records WHERE user_id = $1', [req.session.userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [req.session.userId]);
        await pool.query('COMMIT');

        req.session = null;
        res.json({ message: "Account deleted." });

    } catch (err) {
        if (pool) await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Server error during deletion." });
    }
});

app.get('/api/notifications', async (req, res) => {
    if (!req.session.userId) return res.status(401).json([]);
    
    try {
        const result = await pool.query(`
            SELECT 
                n.*, 
                u.username as admin_name, 
                d.name as level_name
            FROM notifications n
            LEFT JOIN users u ON n.actor_id = u.id
            LEFT JOIN records r ON n.record_id = r.id
            LEFT JOIN demons d ON r.demon_id = d.id
            WHERE n.user_id = $1
            ORDER BY n.created_at DESC
        `, [req.session.userId]);

        res.json(result.rows);
    } catch (err) {
        console.error("Notification Fetch Error:", err);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/notifications/read', async (req, res) => {
    if (!req.session.userId) return res.sendStatus(401);
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
            [req.session.userId]
        );
        res.sendStatus(200);
    } catch (err) {
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
            SELECT username, display_name, role 
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
    const { name, author, levelId, opinion, videoUrl } = req.body;
    const userId = req.session.userId;
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const placementOpinion = parseInt(opinion);
    if (placementOpinion > 150) {
        return res.status(400).json({ error: "You can't submit for the legacy list." });
    }

    try {
        await pool.query(
            `INSERT INTO verifications (user_id, level_name, level_author, level_id, video_url, placement_opinion, list_type) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, name, author, levelId, videoUrl, opinion, list]
        );
        res.json({ message: "Verification submitted successfully!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error during submission." });
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