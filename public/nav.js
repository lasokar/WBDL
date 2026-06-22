async function loadNavbar() {
    const navContainer = document.getElementById('global-nav');
    if (!navContainer) return;

    const res = await fetch('/api/me');

    if (res.status === 429) {
        const rateLimited = await fetch('/ratelimited.html');
        document.documentElement.innerHTML = await rateLimited.text();
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
                    <button class="dropbtn">Menu</button>
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
        <nav style="width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 30px; background: var(--surface); border-bottom: 1px solid var(--border); box-sizing: border-box;">
            <div style="display: flex; align-items: center; gap: 28px; flex-wrap: wrap;">
                <a href="/" style="display: flex; align-items: center; gap: 11px; font-family: var(--font-display); font-size: 1.15em; letter-spacing: 0.5px; color: ${themeColor}; text-decoration: none;">
                    <img src="${brandIcon}" alt="WBDL Icon" style="height: 30px; width: auto; border-radius: 6px;">
                    <span>${brandName}</span>
                </a>
                <a href="/leaderboard" style="${navLink}">Leaderboard</a>
                <a href="/changelog" style="${navLink}">Changelog</a>
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

    // Modern spacing separation from page bounds
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

loadNavbar();
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