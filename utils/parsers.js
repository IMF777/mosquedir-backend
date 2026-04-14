const fs = require('fs');
const csv = require('csv-parser');
const XLSX = require('xlsx');

function detectFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'json') return 'json';
    if (ext === 'csv') return 'csv';
    if (['xls', 'xlsx'].includes(ext)) return 'excel';
    return null;
}

function parseCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

function parseExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(worksheet);
}

function convertToMosques(rawArray) {
    return rawArray.map(item => {
        // Handle different possible field names (case-insensitive)
        const getField = (key) => {
            const found = Object.keys(item).find(k => k.toLowerCase() === key.toLowerCase());
            return found ? item[found] : undefined;
        };

        return {
            id: getField('id'),
            name: getField('name') || '',
            island: getField('island') || '',
            atoll: getField('atoll') || '',
            dhivehi: {
                name: getField('dhivehi_name') || '',
                island: getField('dhivehi_island') || '',
                atoll: getField('dhivehi_atoll') || ''
            },
            friday: parseBool(getField('friday')),
            ladies: parseBool(getField('ladies')),
            capacity: parseInt(getField('capacity')) || 0,
            latitude: parseFloat(getField('latitude')) || 0,
            longitude: parseFloat(getField('longitude')) || 0,
            buildDate: getField('buildDate') || '',
            picture: getField('picture') || '',
            description: getField('description') || '',
            contact: getField('contact') || ''
        };
    });
}

function parseBool(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
    }
    return false;
}

module.exports = {
    detectFileType,
    parseCSV,
    parseExcel,
    convertToMosques
};