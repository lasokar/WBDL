const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { randomBytes } = require('crypto');
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

app.get('/api/demons', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary'; 
    try {
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
        
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
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

async function sendVerificationEmail(targetEmail, username, link) {
    await resend.emails.send({
        from: 'Web Browser Demonlist <verify@webdemonlist.org>',
        to: targetEmail,
        subject: 'Verify your WBDL Account',
        html: `
        <div style="font-family: sans-serif; background-color: #121212; color: white; padding: 40px; border-radius: 8px; max-width: 600px; margin: auto; border: 1px solid #333;">
            <h1 style="color: #0053c2; text-align: center;">Welcome, ${username}!</h1>
            
            <p style="font-size: 16px; line-height: 1.6; text-align: center; color: #ccc;">
                Thanks for signing up for the Web Browser Demonlist! To get started, activate your account by clicking the button below.
            </p>

            <div style="text-align: center; margin: 30px 0;">
                <a href="${link}" style="background-color: #0053c2; color: black; padding: 14px 28px; font-weight: bold; text-decoration: none; border-radius: 4px; display: inline-block;">
                    Verify my Account
                </a>
            </div>

            <div style="background-color: #1a1a1a; padding: 20px; border-radius: 6px; text-align: center; margin-top: 20px;">
                <p style="margin: 0 0 10px 0; color: #fff; font-size: 14px;">Also, feel free to join the discord!</p>
                <a href="https://discord.gg/Pz8TehUPmP" style="color: #5865F2; text-decoration: none; font-weight: bold; font-size: 16px;">
                    discord.gg/Pz8TehUPmP
                </a>
            </div>

            <hr style="border: 0; border-top: 1px solid #333; margin: 20px 0;">
            
            <p style="font-size: 12px; color: #555; text-align: center;">
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
        <div style="font-family: sans-serif; background-color: #121212; color: white; padding: 40px; border-radius: 8px; max-width: 600px; margin: auto; border: 1px solid #333;">
            <h1 style="color: #0053c2; text-align: center;">Password Reset Request</h1>
            <p style="text-align: center; color: #ccc;">Hello ${username}, we received a request to reset your account's password. Click the button below to proceed.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${link}" style="background-color: #0053c2; color: black; padding: 14px 28px; font-weight: bold; text-decoration: none; border-radius: 4px; display: inline-block;">
                    Reset Password
                </a>
            </div>
            <p style="font-size: 12px; color: #555; text-align: center;">This link will expire in 1 hour. If you didn't request this, you can safely ignore this email.</p>
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
                'SELECT username, role FROM users WHERE id = $1', 
                [req.session.userId]
            );

            if (user.rows.length > 0) {
                const userData = user.rows[0];
                res.json({ 
                    loggedIn: true, 
                    username: userData.username, 
                    role: userData.role,
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
    if (!DISCORD_WEBHOOK_URL) return; // Prevent crashes if webhook isn't configured
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
            
            if (above) context.push(`below **${above}**`);
            if (below) context.push(`above **${below}**`);

            if (context.length > 0) msg += ", " + context.join(" and ");
            msg += ` with a list requirement of **${requirement}%**.`;

            let pushes = [];
            if (targetPos <= 75 && old75) pushes.push(`**${old75}** to the Extended List`);
            if (targetPos <= 150 && old150) pushes.push(`**${old150}** to the Legacy List`);
            
            if (pushes.length > 0) {
                msg += `\n*This pushes ${pushes.join(" and ")}.*`;
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

app.post('/api/admin/delete-demon', isAdmin, async (req, res) => {
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
                msg += `\n*This pushes ${pushes.join(" and ")}.*`;
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
            if (above) context.push(`below **${above}**`);
            if (below) context.push(`above **${below}**`);

            if (context.length > 0) msg += ", " + context.join(" and ");
            msg += ".";

            let pushes = [];
            if (newPos < oldPos) { 
                if (newPos <= 75 && oldPos > 75 && old75) pushes.push(`**${old75}** to the Extended List`);
                if (newPos <= 150 && oldPos > 150 && old150) pushes.push(`**${old150}** to the Legacy List`);
            } else if (newPos > oldPos) { 
                if (oldPos <= 75 && newPos >= 76 && old76) pushes.push(`**${old76}** back to the Main List`);
                if (oldPos <= 150 && newPos >= 151 && old151) pushes.push(`**${old151}** back to the Extended List`);
            }

            if (pushes.length > 0) {
                msg += `\n*This pushes ${pushes.join(" and ")}.*`;
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
            'SELECT id, username, created_at, role FROM users WHERE username = $1', 
            [username]
        );
        
        if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
        
        const user = userResult.rows[0];

        const recordsResult = await pool.query(`
            SELECT r.percentage, r.video_url, d.name, d.position, d.requirement, d.id
            FROM records r
            JOIN demons d ON r.demon_id = d.id
            WHERE r.user_id = $1 AND r.status = 'accepted' AND r.list_type = $2 AND d.list_type = $2
            ORDER BY d.position ASC
        `, [user.id, list]);

        const recordsWithPoints = recordsResult.rows.map(r => {
            const basePoints = 250 * Math.exp(-0.0263 * (r.position - 1));
            let awardedPoints = 0;

            if (list === 'impossible') {
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

            return { ...r, points: awardedPoints.toFixed(2) };
        });

        const totalPoints = recordsWithPoints.reduce((sum, r) => sum + parseFloat(r.points), 0).toFixed(2);

        const rankResult = await pool.query(`
            WITH Leaderboard AS (
                SELECT 
                    u.id,
                    SUM(
                        CASE 
                            WHEN $2 = 'impossible' THEN (250 * EXP(-0.0263 * (d.position - 1))) * (r.percentage / 100.0)
                            ELSE
                                CASE 
                                    WHEN r.percentage = 100 THEN (250 * EXP(-0.0263 * (d.position - 1)))
                                    WHEN d.position <= 75 AND r.percentage >= d.requirement THEN (250 * EXP(-0.0263 * (d.position - 1))) / 10
                                    ELSE 0 
                                END
                        END
                    ) as total_score
                FROM users u
                JOIN records r ON u.id = r.user_id
                JOIN demons d ON r.demon_id = d.id
                WHERE r.status = 'accepted' AND r.list_type = $2 AND d.list_type = $2
                GROUP BY u.id
            ),
            RankedPlayers AS (
                SELECT id, total_score, RANK() OVER (ORDER BY total_score DESC) as rank
                FROM Leaderboard
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
                    SUM(
                        CASE 
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
                GROUP BY u.id, u.username
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

        const recordsResult = await pool.query(`
            SELECT records.*, users.username 
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

        res.json({ 
            ...demon, 
            showcase_link,
            records: recordsResult.rows 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
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
    try {
        const history = await pool.query(
            'SELECT * FROM changelog WHERE demon_id = $1 ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json(history.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error fetching demon history" });
    }
});

app.get('/api/changelog', async (req, res) => {
    const list = req.currentList === 'impossible' ? 'impossible' : 'primary';

    try {
        const result = await pool.query(`
            SELECT demon_name, change_type, old_position, new_position, created_at 
            FROM changelog 
            WHERE change_type IN ('added', 'moved', 'deleted') AND list_type = $1
            ORDER BY created_at DESC LIMIT 50
        `, [list]);

        const formattedLogs = result.rows.map(log => {
            let text = "";
            let colorClass = "";

            if (log.change_type === 'added') {
                text = `**${log.demon_name}** was placed at **#${log.new_position}**`;
                colorClass = "text-added";
            } 
            else if (log.change_type === 'moved') {
                text = `**${log.demon_name}** was moved from **#${log.old_position}** to **#${log.new_position}**`;
                colorClass = "text-moved";
            } 
            else if (log.change_type === 'deleted') {
                text = `**${log.demon_name}** was removed from the list`;
                colorClass = "text-deleted";
            }

            return {
                date: log.created_at,
                text: text,
                type: colorClass
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
            SELECT username, role 
            FROM users 
            WHERE role IN ('owner', 'admin', 'moderator')
            ORDER BY 
                CASE role 
                    WHEN 'owner' THEN 1 
                    WHEN 'admin' THEN 2 
                    WHEN 'moderator' THEN 3 
                END ASC, 
                username ASC
        `);

        const staff = {
            owners: result.rows.filter(u => u.role === 'owner'),
            admins: result.rows.filter(u => u.role === 'admin'),
            moderators: result.rows.filter(u => u.role === 'moderator')
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