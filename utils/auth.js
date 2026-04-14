// utils/auth.js
const crypto = require('crypto');
const { readJSON, writeJSON, dataPath } = require('./fileHelpers');

// No hashing - passwords stored as plain text
async function verifyPassword(plainPassword, storedPassword) {
    return plainPassword === storedPassword;
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function verifyToken(token) {
    const users = await readJSON(dataPath('users.json'));
    const user = users.find(u => u.token === token && u.tokenExpiry > Date.now());
    return !!user;
}

async function cleanupExpiredTokens() {
    const users = await readJSON(dataPath('users.json'));
    const now = Date.now();
    const updated = users.map(u => {
        if (u.tokenExpiry && u.tokenExpiry < now) {
            u.token = null;
            u.tokenExpiry = null;
        }
        return u;
    });
    await writeJSON(dataPath('users.json'), updated);
}

module.exports = {
    verifyPassword,
    generateToken,
    verifyToken,
    cleanupExpiredTokens
};