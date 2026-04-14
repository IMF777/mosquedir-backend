const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { readJSON, writeJSON, dataPath } = require('./utils/fileHelpers');
const { verifyPassword, generateToken, cleanupExpiredTokens } = require('./utils/auth');
const { parseCSV, parseExcel, detectFileType, convertToMosques } = require('./utils/parsers');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Initialize files if they don't exist
const mosquesFile = dataPath('mosques.json');
const usersFile = dataPath('users.json');
const settingsFile = dataPath('settings.json');

if (!fs.existsSync(mosquesFile)) writeJSON(mosquesFile, []);
if (!fs.existsSync(usersFile)) writeJSON(usersFile, []);
if (!fs.existsSync(settingsFile)) writeJSON(settingsFile, { lastMapPosition: { lat: 4.1755, lng: 73.5093, zoom: 13 } });

// Cleanup expired tokens on startup
cleanupExpiredTokens();

// Multer setup for file uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = ['application/json', 'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
        if (allowed.includes(file.mimetype) || file.originalname.endsWith('.csv') || file.originalname.endsWith('.xlsx')) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JSON, CSV, Excel files allowed.'));
        }
    }
});

// ---------- Public Endpoints ----------

app.use(express.static(path.join(__dirname, 'frontend')));

// GET /api/all - Return all mosques
app.get('/api/all', async (req, res) => {
    try {
        const mosques = await readJSON(mosquesFile);
        res.json(mosques);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read mosque data.' });
    }
});

// GET /api/mosque - Search by name (partial match, case-insensitive)
app.get('/api/mosque', async (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Missing name parameter' });
    try {
        const mosques = await readJSON(mosquesFile);
        const results = mosques.filter(m => 
            m.name.toLowerCase().includes(name.toLowerCase()) ||
            (m.dhivehi && m.dhivehi.name && m.dhivehi.name.includes(name))
        );
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Search failed' });
    }
});

// GET /filter - Advanced filtering
app.get('/api/filter', async (req, res) => {
    try {
        const mosques = await readJSON(mosquesFile);
        let filtered = [...mosques];

        // Handle query parameters
        for (const [key, value] of Object.entries(req.query)) {
            if (key.endsWith('_gt')) {
                const field = key.slice(0, -3);
                filtered = filtered.filter(m => m[field] > Number(value));
            } else if (key.endsWith('_lt')) {
                const field = key.slice(0, -3);
                filtered = filtered.filter(m => m[field] < Number(value));
            } else if (key.endsWith('_eq')) {
                const field = key.slice(0, -3);
                filtered = filtered.filter(m => m[field] == value);
            } else {
                // Default exact match or boolean
                if (value === 'true' || value === 'false') {
                    filtered = filtered.filter(m => m[key] === (value === 'true'));
                } else {
                    filtered = filtered.filter(m => m[key] && m[key].toString().toLowerCase() === value.toLowerCase());
                }
            }
        }
        res.json(filtered);
    } catch (error) {
        res.status(500).json({ error: 'Filter failed' });
    }
});

// ---------- Admin Authentication ----------

// GET /admin - Serve login page
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'login.html'));
});

// POST /requestAdmin - Login attempt (no rate limiting)
// POST /requestAdmin - Login attempt or auto-login with token
app.post('/requestAdmin', async (req, res) => {
    const { username, password, autoLogin, token } = req.body;
    
    // Handle auto-login with existing token
    if (autoLogin && token) {
        try {
            const users = await readJSON(usersFile);
            const user = users.find(u => u.token === token && u.tokenExpiry > Date.now());
            
            if (user) {
                // Token is valid, serve dashboard
                const dashboardPath = path.join(__dirname, 'admin', 'dashboard.html');
                let dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
                dashboardHtml = dashboardHtml.replace('{{TOKEN}}', token);
                return res.send(dashboardHtml);
            } else {
                return res.status(401).send('Invalid or expired token');
            }
        } catch (error) {
            return res.status(500).send('Server error');
        }
    }
    
    // Regular login flow
    if (!username || !password) {
        return res.status(400).send('Username and password required');
    }

    try {
        const users = await readJSON(usersFile);
        const user = users.find(u => u.username === username);
        if (!user) return res.status(401).send('Invalid credentials');

        const valid = await verifyPassword(password, user.password);
        if (!valid) return res.status(401).send('Invalid credentials');

        // Generate token and set expiry (14 days)
        const newToken = generateToken();
        const expiry = Date.now() + 14 * 24 * 60 * 60 * 1000;
        user.token = newToken;
        user.tokenExpiry = expiry;
        await writeJSON(usersFile, users);

        // Serve dashboard HTML with token injected
        const dashboardPath = path.join(__dirname, 'admin', 'dashboard.html');
        let dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
        dashboardHtml = dashboardHtml.replace('{{TOKEN}}', newToken);
        res.send(dashboardHtml);
    } catch (error) {
        res.status(500).send('Server error');
    }
});

// Admin middleware to protect routes
async function adminAuth(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1]; // Bearer TOKEN
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        const users = await readJSON(usersFile);
        const user = users.find(u => u.token === token && u.tokenExpiry > Date.now());
        if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    } catch (error) {
        res.status(500).json({ error: 'Auth check failed' });
    }
}

// ---------- Admin Endpoints (Protected) ----------

// POST /append - Add or edit mosque
app.post('/append', adminAuth, async (req, res) => {
    const mosqueData = req.body;
    if (!mosqueData.name || !mosqueData.island || !mosqueData.atoll) {
        return res.status(400).json({ error: 'Missing required fields: name, island, atoll' });
    }

    try {
        const mosques = await readJSON(mosquesFile);
        const existingIndex = mosques.findIndex(m => 
            m.name === mosqueData.name && m.island === mosqueData.island && m.atoll === mosqueData.atoll
        );

        if (existingIndex !== -1) {
            // Update existing
            mosqueData.id = mosques[existingIndex].id; // preserve id
            mosques[existingIndex] = { ...mosques[existingIndex], ...mosqueData };
        } else {
            // Add new
            mosqueData.id = require('uuid').v4();
            mosques.push(mosqueData);
        }

        await writeJSON(mosquesFile, mosques);
        res.json({ success: true, mosque: mosqueData });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save mosque' });
    }
});

// POST /uploadData - Bulk upload (JSON/CSV/Excel)
app.post('/uploadData', adminAuth, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const mode = req.body.mode; // 'merge' or 'replace'
    if (!['merge', 'replace'].includes(mode)) {
        return res.status(400).json({ error: 'Mode must be "merge" or "replace"' });
    }

    try {
        const filePath = req.file.path;
        const fileType = detectFileType(req.file.originalname);
        let newMosques = [];

        if (fileType === 'json') {
            const content = fs.readFileSync(filePath, 'utf8');
            newMosques = JSON.parse(content);
        } else if (fileType === 'csv') {
            newMosques = await parseCSV(filePath);
        } else if (fileType === 'excel') {
            newMosques = parseExcel(filePath);
        } else {
            throw new Error('Unsupported file type');
        }

        // Convert raw data to mosque structure (ensure required fields)
        newMosques = convertToMosques(newMosques);

        // Validate
        for (const m of newMosques) {
            if (!m.name || !m.island || !m.atoll) {
                throw new Error('All mosques must have name, island, atoll');
            }
        }

        const existingMosques = await readJSON(mosquesFile);
        let finalMosques;

        if (mode === 'replace') {
            finalMosques = newMosques.map(m => ({ ...m, id: m.id || require('uuid').v4() }));
        } else { // merge
            finalMosques = [...existingMosques];
            for (const newM of newMosques) {
                const existingIndex = finalMosques.findIndex(m => 
                    m.name === newM.name && m.island === newM.island && m.atoll === newM.atoll
                );
                if (existingIndex !== -1) {
                    finalMosques[existingIndex] = { ...finalMosques[existingIndex], ...newM, id: finalMosques[existingIndex].id };
                } else {
                    finalMosques.push({ ...newM, id: require('uuid').v4() });
                }
            }
        }

        await writeJSON(mosquesFile, finalMosques);
        // Clean up uploaded file
        fs.unlinkSync(filePath);
        res.json({ success: true, count: finalMosques.length });
    } catch (error) {
        // Clean up on error
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(400).json({ error: error.message });
    }
});

// GET /download - Download database in specified format
app.get('/download', adminAuth, async (req, res) => {
    const format = req.query.format || 'json';
    try {
        const mosques = await readJSON(mosquesFile);
        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename=mosques.json');
            res.send(JSON.stringify(mosques, null, 2));
        } else if (format === 'csv') {
            // Convert to CSV
            const { Parser } = require('json2csv');
            const fields = ['id', 'name', 'island', 'atoll', 'friday', 'ladies', 'capacity', 'latitude', 'longitude', 'buildDate', 'picture', 'description', 'contact'];
            const parser = new Parser({ fields });
            const csv = parser.parse(mosques);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=mosques.csv');
            res.send(csv);
        } else if (format === 'excel') {
            const XLSX = require('xlsx');
            const worksheet = XLSX.utils.json_to_sheet(mosques);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Mosques');
            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=mosques.xlsx');
            res.send(buffer);
        } else {
            res.status(400).json({ error: 'Invalid format' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Download failed' });
    }
});

// POST /logout - Invalidate token
app.post('/logout', adminAuth, async (req, res) => {
    try {
        const users = await readJSON(usersFile);
        const user = users.find(u => u.token === req.user.token);
        if (user) {
            user.token = null;
            user.tokenExpiry = null;
            await writeJSON(usersFile, users);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Logout failed' });
    }
});

// GET /api/stats - Get database statistics (public)
app.get('/api/stats', async (req, res) => {
    try {
        const mosques = await readJSON(mosquesFile);
        const atolls = [...new Set(mosques.map(m => m.atoll))];
        const islands = [...new Set(mosques.map(m => m.island))];
        const fridayCount = mosques.filter(m => m.friday).length;
        const ladiesCount = mosques.filter(m => m.ladies).length;
        
        res.json({
            totalMosques: mosques.length,
            totalAtolls: atolls.length,
            totalIslands: islands.length,
            fridayMosques: fridayCount,
            ladiesMosques: ladiesCount,
            lastUpdated: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
});