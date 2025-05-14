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

function parseSlackIframeHtml(htmlString) {
    // Detect order number
    const orderMatch = htmlString.match(/El pedido (\d+)/);
    const orderNumber = orderMatch ? orderMatch[1] : null;

    // Detect status: reembolso o anulación
    let status, motive;
    if (htmlString.includes("fue anulado")) {
        status = "anulado";
        const motiveMatch = htmlString.match(/con motivo ([\w_]+)/);
        motive = motiveMatch ? motiveMatch[1] : null;
    } else if (htmlString.includes("fue reembolsado")) {
        status = "reembolsado";
        motive = null;
    } else {
        status = "desconocido";
        motive = null;
    }

    // Extract Odoo link
    let odooLink = null;
    const lines = htmlString.split('\n');
    for (const line of lines) {
        if (line.includes("https://nilus-ar.odoo.com")) {
            odooLink = line.trim();
            break;
        }
    }

    // Extract products
    const products = [];
    if (status === "reembolsado") {
        const productsLines = [];
        let insideBlock = false;

        for (const line of lines) {
            if (line.includes("fue reembolsado")) {
                insideBlock = true;
                continue;
            }
            if (line.includes("Backoffice:")) {
                insideBlock = false;
            }
            if (insideBlock) {
                productsLines.push(line.trim());
            }
        }

        // Clean lines
        const cleanLines = productsLines.filter(line => line && !line.startsWith("https"));

        let currentProduct = {};
        for (const line of cleanLines) {
            if (!line || line.startsWith("https")) continue;

            if (line.match(/^Support - DTC/)) {
                currentProduct.support_info = line;
            } else if (line.startsWith("x")) {
                const quantityMatch = line.match(/x(\d+)/);
                currentProduct.quantity = quantityMatch ? quantityMatch[1] : "0";
            } else if (line.startsWith("$")) {
                const priceMatch = line.match(/\$(\d+\.?\d*)/);
                currentProduct.price = priceMatch ? priceMatch[1] : "0";
                products.push(currentProduct);
                currentProduct = {};
            } else if (line.match(/^\d{1,4}$/)) {
                if (line.length > 3) {
                    currentProduct.product_id = parseInt(line).toLocaleString('en-US').replace(/,/g, '.');
                } else {
                    currentProduct.product_id = line;
                }
            } else {
                currentProduct.product_name = line;
            }
        }

        if (Object.keys(currentProduct).length > 0) {
            products.push(currentProduct);
        }
    }

    return {
        order_number: orderNumber,
        status,
        motive,
        products,
        odoo_link: odooLink
    };
}

function formatReclamoForSheet(reclamoData) {
    const row = [];
    // Only add values that exist
    if (reclamoData.status !== undefined) row.push(reclamoData.status);
    if (reclamoData.output !== undefined) row.push(reclamoData.output);
    return [row];
}

// Asynchronous function to write data to a Google Sheet.
const writeToSheet = async (data) => {
    const sheets = google.sheets({ version: 'v4', auth });
  
    const requests = [];
  
    data.forEach((item) => {
      const { rowId, status, output } = item;
      if (!rowId) return; // Skip if rowId is missing
      const concatOutput = output.join('');
  
      // Always write both columns, even if empty
      const values = [status, concatOutput];
  
      // Range: Always write to columns B and C
      const range = `${config.sheetName}!B${rowId}:C${rowId}`;
  
      requests.push({
        range,
        values: [values],
      });
    });
  
    if (requests.length === 0) return;
  
    try {
      const res = await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: requests
        }
      });
      console.log("Finished writing to sheet");
      return res;
    } catch (error) {
      console.error('Batch update error:', error);
      throw error;
    }
  };
  

// Asynchronous function to read data from a Google Sheet.
const readSheet = async () => {
    const sheets = google.sheets({ version: 'v4', auth });
    const range = `${config.sheetName}!${config.defaultRange}`;

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: config.spreadsheetId,
            range,
        });

        const rows = response.data.values || [];

        // Map first to include real row number (header is row 1)
        const structuredRows = rows.map((row, index) => ({
            rowId: index + 2, // +2 because row 1 is header and Sheets is 1-indexed
            reclamo: parseSlackIframeHtml(parseNotification(row[0] || '')),
            status: row[1] || '',
            output: row[2] || ''
        }));

        // Then filter based on the data content
        return structuredRows.filter(
            row => row.status === "Compartidas" && (!row.output || row.output.trim() === '')
        );
    } catch (error) {
        console.error('error', error);
        return [];
    }
};


module.exports = {
    writeToSheet,
    readSheet,
    config
};