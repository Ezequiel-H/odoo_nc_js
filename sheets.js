const { google } = require('googleapis');

// Configuration
const config = {
    spreadsheetId: '1z_WHVRBdsgYEYQifmqngf65_MzcSbp9woPlOhcda6_A',
    sheetName: 'Sheet2',
    defaultRange: 'A2:C'  // Changed to read all of column A
};

// Initializes the Google APIs client library and sets up the authentication using service account credentials.
const auth = new google.auth.GoogleAuth({
    keyFile: './google.json',  // Path to your service account key file.
    scopes: ['https://www.googleapis.com/auth/spreadsheets']  // Scope for Google Sheets API.
});

function parseNotification(rawInput) {
    const rawString = String(rawInput); // Ensure it's a string
    return rawString
        .replace(/\r\n/g, '\n')           // Convert CRLF to LF
        .replace(/\t/g, ' ')              // Replace tabs with spaces
        .replace(/\n{3,}/g, '\n\n')       // Collapse 3+ newlines to 2
        .trim();                          // Remove leading/trailing whitespace
}


// Asynchronous function to write data to a Google Sheet.
const writeToSheet = async (values) => {
    const sheets = google.sheets({ version: 'v4', auth });  // Creates a Sheets API client instance.
    const range = `${config.sheetName}!A1`;  // The range in the sheet where data will be written.
    const valueInputOption = 'USER_ENTERED';  // How input data should be interpreted.

    const resource = { values };  // The data to be written.

    try {
        const res = await sheets.spreadsheets.values.update({
            spreadsheetId: config.spreadsheetId,
            range,
            valueInputOption,
            resource
        })
        return res;  // Returns the response from the Sheets API.
    } catch (error) {
        console.error('error', error);  // Logs errors.
    }
}

// Asynchronous function to read data from a Google Sheet.
const readSheet = async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const range = `${config.sheetName}!${config.defaultRange}`;

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.spreadsheetId,
            range,
        });
        const resp = response.data.values;
        console.log("resp", parseNotification(resp[0]));
        console.log("typeof resp:", typeof resp);
        return resp;
    } catch (error) {
        console.error('error', error);
        return []; // Returns empty array on error
    }
}

module.exports = {
    writeToSheet,
    readSheet,
    config
};