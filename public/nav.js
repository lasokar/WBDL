
const TIME_MACHINE_MIN_DATE_FALLBACK = '2026-01-01';
let timeMachineMinDateCache = null;
let timeMachineMinDatePromise = null;

function getTodayDateInputValue() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseDateInputValue(value) {
    const raw = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;

    const date = new Date(`${raw}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
}

async function getTimeMachineMinDate() {
    if (timeMachineMinDateCache) return timeMachineMinDateCache;

    if (!timeMachineMinDatePromise) {
        timeMachineMinDatePromise = fetch('/api/time-machine/min-date', { cache: 'no-store' })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                const minDate = data && data.min_date;
                timeMachineMinDateCache = parseDateInputValue(minDate) ? minDate : TIME_MACHINE_MIN_DATE_FALLBACK;
                return timeMachineMinDateCache;
            })
            .catch(() => {
                timeMachineMinDateCache = TIME_MACHINE_MIN_DATE_FALLBACK;
                return timeMachineMinDateCache;
            });
    }

    return timeMachineMinDatePromise;
}

async function isValidTimeMachineDateAsync(value) {
    return isValidTimeMachineDate(value, await getTimeMachineMinDate());
}

function isValidTimeMachineDate(value, minDateValue = TIME_MACHINE_MIN_DATE_FALLBACK) {
    const selected = parseDateInputValue(value);
    if (!selected) return false;

    const min = parseDateInputValue(minDateValue || TIME_MACHINE_MIN_DATE_FALLBACK);
    const max = parseDateInputValue(getTodayDateInputValue());

    return selected >= min && selected <= max;
}

function removeTimeMachineParamsFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('date');
    url.searchParams.delete('timemachine');

    const next = `${url.pathname}${url.search}${url.hash}`;
    return next || '/';
}

async function redirectInvalidTimeMachineDate() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('date')) return false;

    const date = params.get('date');
    if (await isValidTimeMachineDateAsync(date)) return false;

    window.location.replace(removeTimeMachineParamsFromUrl());
    return true;
}

function formatTimeMachineDate(dateValue) {
    const date = parseDateInputValue(dateValue);
    if (!date) return dateValue || '';

    return date.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    });
}

async function getCurrentTimeMachineDate() {
    const params = new URLSearchParams(window.location.search);
    const date = params.get('date');
    return await isValidTimeMachineDateAsync(date) ? date : '';
}

function openTimeMachineDatePicker(event) {
    const input = document.getElementById('time-machine-date');
    if (!input) return;

    if (event && event.target !== input) {
        event.preventDefault();
    }

    input.focus();

    if (typeof input.showPicker === 'function') {
        try {
            input.showPicker();
        } catch (err) {}
    }
}

function isIndexPage() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return path === '/';
}

async function ensureTimeMachinePopup() {
    if (document.getElementById('time-machine-overlay')) return;

    const currentParams = new URLSearchParams(window.location.search);
    const selectedDate = currentParams.get('date') || getTodayDateInputValue();
    const maxDate = getTodayDateInputValue();
    const minDate = await getTimeMachineMinDate();

    const overlay = document.createElement('div');
    overlay.id = 'time-machine-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(4px);padding:20px;box-sizing:border-box;';
    overlay.innerHTML = `
        <div style="width:min(420px,100%);background:var(--surface,#161616);border:1px solid var(--border,#333);border-radius:var(--radius,14px);box-shadow:0 20px 70px rgba(0,0,0,0.55);padding:22px;box-sizing:border-box;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px;">
                <h2 style="margin:0;color:var(--text,#fff);font-size:1.35rem;">Time Machine</h2>
                <button type="button" onclick="closeTimeMachine()" aria-label="Close" style="background:transparent;border:0;color:var(--text-muted,#888);font-size:1.6rem;line-height:1;cursor:pointer;">&times;</button>
            </div>
            <p style="margin:0 0 14px;color:var(--text-muted,#888);line-height:1.45;font-size:0.95rem;">
                IS THAT A GEOMETRY DASH REFERENCE?!?!?!
            </p>
            <label for="time-machine-date" style="display:block;color:var(--text,#fff);font-weight:800;margin-bottom:7px;">Date</label>
            <div onclick="openTimeMachineDatePicker(event)" style="width:100%;padding:0;background:var(--bg,#111);border:1px solid var(--border,#333);border-radius:var(--radius-sm,8px);box-sizing:border-box;cursor:pointer;">
                <input id="time-machine-date" type="date" min="${minDate}" max="${maxDate}" value="${isValidTimeMachineDate(selectedDate, minDate) ? selectedDate : maxDate}" onclick="openTimeMachineDatePicker(event)" onfocus="openTimeMachineDatePicker(event)" style="width:100%;padding:12px 13px;background:transparent;border:0;color:var(--text,#fff);font:inherit;box-sizing:border-box;cursor:pointer;">
            </div>
            <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;flex-wrap:wrap;">
                <button type="button" onclick="applyTimeMachineFromPopup()" style="padding:10px 14px;border-radius:var(--radius-sm,8px);border:1px solid var(--border,#333);background:var(--surface-2,#222);color:var(--text,#fff);font-weight:800;cursor:pointer;">Go!</button>
            </div>
        </div>
    `;

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeTimeMachine();
    });

    document.body.appendChild(overlay);
}

async function openTimeMachine() {
    if (!isIndexPage()) {
        window.location.href = '/?timemachine=1';
        return;
    }

    await ensureTimeMachinePopup();
    const overlay = document.getElementById('time-machine-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeTimeMachine() {
    const overlay = document.getElementById('time-machine-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function applyTimeMachineFromPopup() {
    const input = document.getElementById('time-machine-date');
    const date = input ? input.value : '';

    if (!date) return;

    if (!(await isValidTimeMachineDateAsync(date))) {
        window.location.href = removeTimeMachineParamsFromUrl();
        return;
    }

    if (typeof window.applyTimeMachineDate === 'function') {
        window.applyTimeMachineDate(date);
        closeTimeMachine();
        return;
    }

    window.location.href = `/?date=${encodeURIComponent(date)}`;
}

function resetTimeMachine() {
    if (typeof window.applyTimeMachineDate === 'function') {
        window.applyTimeMachineDate('');
        closeTimeMachine();
        return;
    }

    window.location.href = removeTimeMachineParamsFromUrl();
}

async function openTimeMachineFromQuery() {
    if (await redirectInvalidTimeMachineDate()) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get('timemachine') === '1') {
        openTimeMachine();
    }
}


function renderTimeMachineNavbar(navContainer, date) {
    navContainer.innerHTML = `
        <style>
            #global-nav button {
                width: auto !important;
                margin-top: 0 !important;
                flex: 0 0 auto;
            }

            #global-nav .nav-time-machine-button {
                background: transparent !important;
                border: 0 !important;
                padding: 0 !important;
                color: #c3c8cf !important;
                text-decoration: none !important;
                font-weight: 500 !important;
                font-size: 0.98em !important;
                font-family: inherit !important;
                cursor: pointer !important;
            }

            #global-nav .dropbtn {
                width: auto !important;
                margin-top: 0 !important;
                padding: 8px 13px !important;
                background: var(--surface-2) !important;
                border: 1px solid var(--border) !important;
                color: var(--text) !important;
                border-radius: var(--radius-sm) !important;
                font-family: var(--font-body) !important;
                font-weight: 700 !important;
                cursor: pointer !important;
            }

            #global-nav .dropdown-content button {
                width: 100% !important;
                margin: 0 !important;
                padding: 10px 14px !important;
                background: transparent !important;
                border: 0 !important;
                color: var(--text) !important;
                border-radius: 0 !important;
                text-align: left !important;
                font-family: var(--font-body) !important;
                font-weight: 600 !important;
            }

            #global-nav .dropdown-content button:hover {
                background: var(--surface-2) !important;
                color: var(--accent) !important;
            }
        </style>
        <nav style="width: 100%; min-height: 59px; display: flex; justify-content: center; align-items: center; gap: 14px; padding: 14px 30px; background: var(--surface); border-bottom: 1px solid var(--border); box-sizing: border-box; text-align: center; flex-wrap: wrap;">
            <span style="color: var(--text); font-weight: 800;">
                You are viewing the list as it was in ${formatTimeMachineDate(date)}
            </span>
            <button type="button" onclick="resetTimeMachine()" style="width: auto; margin-top: 0; padding: 7px 13px; border-radius: var(--radius-sm, 8px); border: 0; background: var(--accent); color: #000; cursor: pointer; font: inherit; font-weight: 900;">
                Back to present
            </button>
        </nav>
    `;
}

async function loadNavbar() {
    const navContainer = document.getElementById('global-nav');
    if (!navContainer) return;

    if (await redirectInvalidTimeMachineDate()) return;

    const activeTimeMachineDate = await getCurrentTimeMachineDate();

    const res = await fetch('/api/me');

    if (res.status === 429) {
        const rateLimited = await fetch('/ratelimited.html');
        document.documentElement.innerHTML = await rateLimited.text();
        return;
    }

    if (activeTimeMachineDate) {
        renderTimeMachineNavbar(navContainer, activeTimeMachineDate);
        return;
    }

    const user = await res.json();

    const isImpossibleList = window.location.hostname.includes('impossible');

    const themeColor = isImpossibleList ? "#ff4444" : "#00e676";
    const brandName = isImpossibleList ? "WBDL Impossible List" : "Web Browser Demonlist";

    const brandIcon = isImpossibleList ? "/assets/impossible.png" : "/assets/icon.png";

    const navLink = "color: #c3c8cf; text-decoration: none; font-weight: 500; font-size: 0.98em; transition: color 0.15s;";

    const currentHost = window.location.host; 
    let listSwapLink = "";

    if (isImpossibleList) {
        const mainHost = currentHost.replace(/^impossible\./, '');
        listSwapLink = `<a href="//${mainHost}" style="${navLink}">Main List</a>`;
    } else {
        listSwapLink = `<a href="//impossible.${currentHost}" style="${navLink}">ILL</a>`;
    }

    let userSection = `
        <a href="/login" style="color: #c3c8cf; text-decoration: none; margin-right: 18px; font-weight: 600;">Login</a>
        <a href="/register" style="color: #000; background: ${themeColor}; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-weight: 700;">Register</a>
    `;

    if (user.loggedIn) {
        userSection = `
            <div class="nav-right" style="display: flex; align-items: center; gap: 15px;">
                <div class="notification-wrapper">
                    <a href="/notifications" class="noti-link">
                        <img src="/assets/notifications.png" alt="Notifications">
                        <span id="noti-badge" style="display:none;">0</span>
                    </a>
                </div>
                
                <div class="dropdown">
                    <button class="dropbtn" type="button">Menu</button>
                    <div class="dropdown-content">
                        <a href="/profile?user=${user.username}">My Profile</a>
                        <a href="/account-settings">Account Settings</a>
                        <a href="/submit">Record Submitter</a>

                        ${['moderator', 'admin', 'owner'].includes(user.role) ?
                            `<a href="/moderators" style="color: ${themeColor}; font-weight: 700;">Mod Tools</a>` : ''}

                        ${['admin', 'owner'].includes(user.role) ?
                            `<a href="/admin" style="color: ${themeColor}; font-weight: 700;">Admin Panel</a>` : ''}

                        <hr style="border: 0; border-top: 1px solid var(--border); margin: 0;">
                        <button onclick="logout()">Logout</button>
                    </div>
                </div>
            </div>
        `;
    }

    navContainer.innerHTML = `
        <style>
            #global-nav button {
                width: auto !important;
                margin-top: 0 !important;
                flex: 0 0 auto;
            }

            #global-nav .nav-time-machine-button {
                background: transparent !important;
                border: 0 !important;
                padding: 0 !important;
                color: #c3c8cf !important;
                text-decoration: none !important;
                font-weight: 500 !important;
                font-size: 0.98em !important;
                font-family: inherit !important;
                cursor: pointer !important;
            }

            #global-nav .dropbtn {
                width: auto !important;
                margin-top: 0 !important;
                padding: 8px 13px !important;
                background: var(--surface-2) !important;
                border: 1px solid var(--border) !important;
                color: var(--text) !important;
                border-radius: var(--radius-sm) !important;
                font-family: var(--font-body) !important;
                font-weight: 700 !important;
                cursor: pointer !important;
            }

            #global-nav .dropdown-content button {
                width: 100% !important;
                margin: 0 !important;
                padding: 10px 14px !important;
                background: transparent !important;
                border: 0 !important;
                color: var(--text) !important;
                border-radius: 0 !important;
                text-align: left !important;
                font-family: var(--font-body) !important;
                font-weight: 600 !important;
            }

            #global-nav .dropdown-content button:hover {
                background: var(--surface-2) !important;
                color: var(--accent) !important;
            }
        </style>
        <nav style="width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 30px; background: var(--surface); border-bottom: 1px solid var(--border); box-sizing: border-box;">
            <div style="display: flex; align-items: center; gap: 28px; flex-wrap: wrap;">
                <a href="/" style="display: flex; align-items: center; gap: 11px; font-family: var(--font-display); font-size: 1.15em; letter-spacing: 0.5px; color: ${themeColor}; text-decoration: none;">
                    <img src="${brandIcon}" alt="WBDL Icon" style="height: 30px; width: auto; border-radius: 6px;">
                    <span>${brandName}</span>
                </a>
                <a href="/leaderboard" style="${navLink}">Leaderboard</a>
                <a href="/changelog" style="${navLink}">Changelog</a>
                <button type="button" class="nav-time-machine-button" onclick="openTimeMachine()" style="${navLink} width: auto; margin-top: 0; background: transparent; border: 0; padding: 0; cursor: pointer; font-family: inherit;">Time Machine</button>
                ${listSwapLink}
            </div>
            <div id="user-nav">${userSection}</div>
        </nav>
    `;

    if (user.loggedIn) {
        updateNotiBadge();
    }
}

async function logout() {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (res.ok) window.location.href = "/";
}

async function loadFooter() {
    let footerContainer = document.getElementById('global-footer');
    
    if (!footerContainer) {
        footerContainer = document.createElement('footer');
        footerContainer.id = 'global-footer';
        document.body.appendChild(footerContainer);
    }

    footerContainer.style.width = "100%";
    footerContainer.style.display = "flex";
    footerContainer.style.justifyContent = "center";
    footerContainer.style.borderTop = "1px solid var(--border, #222)";
    footerContainer.style.marginTop = "50px";
    footerContainer.style.backgroundColor = "var(--surface, #161616)";
    
    footerContainer.innerHTML = `
        <div class="footer-content" style="display: flex; justify-content: space-around; gap: 40px; flex-wrap: wrap; width: 100%; max-width: 900px; padding: 30px 20px; box-sizing: border-box;">
            
            <div class="footer-section" style="display: flex; flex-direction: column; align-items: flex-start; min-width: 160px;">
                <h3 style="margin: 0 0 10px 0; font-size: 0.82em; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text, #fff); font-family: var(--font-display), sans-serif; font-weight: 700; opacity: 0.9;">Info</h3>
                <a href="/about" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">About WBDL</a>
                <a href="/guidelines" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">Submission Rules</a>
                <a href="/leaderboard" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">Leaderboard</a>
                <a href="/changelog" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">List Changes</a>
                <a href="/staff" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 0; transition: color 0.15s;">Staff</a>
            </div>
            
            <div class="footer-section" style="display: flex; flex-direction: column; align-items: flex-start; min-width: 160px;">
                <h3 style="margin: 0 0 10px 0; font-size: 0.82em; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text, #fff); font-family: var(--font-display), sans-serif; font-weight: 700; opacity: 0.9;">Socials</h3>
                <a href="https://discord.gg/Pz8TehUPmP" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">Discord Server</a>
                <a href="https://github.com/lasokar/WBDL" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">GitHub Repo</a>
                <a href="https://youtube.com/@lasokar" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 0; transition: color 0.15s;">YouTube</a>
            </div>

            <div class="footer-section" style="display: flex; flex-direction: column; align-items: flex-start; min-width: 160px;">
                <h3 style="margin: 0 0 10px 0; font-size: 0.82em; text-transform: uppercase; letter-spacing: 1.5px; color: var(--text, #fff); font-family: var(--font-display), sans-serif; font-weight: 700; opacity: 0.9;">Credits</h3>
                <a href="https://www.youtube.com/@RobTopGames" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">RobTop Games</a>
                <a href="https://geometrydash.com" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">Geometry Dash</a>
                <a href="https://github.com/brokemutt/gdweb" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 6px; transition: color 0.15s;">GDWeb</a>
                <a href="https://github.com/web-dashers/web-dashers.github.io" target="_blank" style="color: var(--text-muted, #888); text-decoration: none; font-size: 0.92em; margin-bottom: 0; transition: color 0.15s;">Web Dashers</a>
            </div>
        </div>
    `;
}

window.getTimeMachineMinDate = getTimeMachineMinDate;
window.isValidTimeMachineDateAsync = isValidTimeMachineDateAsync;

loadNavbar().then(openTimeMachineFromQuery);
loadFooter();

async function updateNotiBadge() {
    const res = await fetch('/api/notifications');
    const notifications = await res.json();
    const unreadCount = notifications.filter(n => !n.is_read).length;
    
    const badge = document.getElementById('noti-badge');
    if (unreadCount > 0) {
        badge.innerText = unreadCount;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

(function() {
    const isImpossibleList = window.location.hostname.includes('impossible');

    if (isImpossibleList) {
        document.body.classList.add('impossible-list');
    }
})();