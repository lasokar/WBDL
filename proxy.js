const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());

app.use(async (req, res) => {
    try {
        const targetUrl = `https://webdemonlist.org${req.url}`;

        const response = await fetch(targetUrl);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch from live site" });
    }
});

app.listen(3001, () => console.log('Universal live data proxy running on http://localhost:3001'));