const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Constants
const MOTIVOS_ANULADO = {
    'dropoff_closed_point': 'Baja del punto de entrega',
};

const MOTIVOS_REEMBOLSADO = {
    'Support - DTC - Contact - Missing Product': 'Productos faltantes',
    'Support - DTC - Contact - Wrong Product': 'Productos faltantes',
    'Support - DTC - Contact - Product in bad condition': 'Productos faltantes',
    'Support - DTC - Contact - Missing Order': 'Productos faltantes',
    'Support - DTC - Operations - Missing Product': 'Productos faltantes',
    'Support - DTC - Operations - Product Replacement': 'Productos faltantes',
    'Support - DTC - Operations - Order nor Delivered': 'Productos faltantes',
};

// Helper function to click buttons
async function clickButton(page, selector, type = 'css') {
    try {
        if (type === 'css') {
            await page.waitForSelector(selector, { visible: true });
            await page.click(selector);
        } else if (type === 'xpath') {
            // Manual waitForXPath replacement
            const timeout = 30000;
            const pollInterval = 100;
            const start = Date.now();
            let input;

            while (Date.now() - start < timeout) {
                const handles = await page.$x(selector);
                if (handles.length > 0) {
                    const box = await handles[0].boundingBox();
                    if (box) {
                        input = handles[0];
                        break;
                    }
                }
                await new Promise(res => setTimeout(res, pollInterval));
            }

            if (!input) throw new Error(`Timeout waiting for XPath: ${selector}`);
            await input.click();
        } else {
            throw new Error(`Unsupported selector type: ${type}`);
        }
        return true;
    } catch (e) {
        console.error(`Error clicking button with selector (${type}): ${selector}\n${e}`);
        return false;
    }
}

// Parse Slack iframe HTML
function parseSlackIframeHtml(htmlString) {
    // Detect order number
    const orderMatch = htmlString.match(/El pedido (\d+)/);
    const orderNumber = orderMatch ? orderMatch[1] : null;

    // Detect status
    let status, motive;
    if (htmlString.includes('fue anulado')) {
        status = 'anulado';
        const motiveMatch = htmlString.match(/con motivo ([\w_]+)/);
        motive = motiveMatch ? motiveMatch[1] : null;
    } else if (htmlString.includes('fue reembolsado')) {
        status = 'reembolsado';
        motive = null;
    } else {
        status = 'desconocido';
        motive = null;
    }

    // Extract Odoo link
    let odooLink = null;
    for (const line of htmlString.split('\n')) {
        if (line.includes('https://nilus-ar-test.odoo.com')) {
            odooLink = line.trim();
            break;
        }
    }

    // Extract products
    const products = [];
    if (status === 'reembolsado') {
        const lines = htmlString.split('\n');
        let productsLines = [];
        let insideBlock = false;

        for (const line of lines) {
            if (line.includes('fue reembolsado')) {
                insideBlock = true;
                continue;
            }
            if (line.includes('Backoffice:')) {
                insideBlock = false;
            }
            if (insideBlock) {
                productsLines.push(line.trim());
            }
        }

        // Clean lines
        productsLines = productsLines.filter(line => line && !line.startsWith('https'));

        // Parse products
        let currentProduct = {};
        for (const line of productsLines) {
            if (currentProduct.product_name && currentProduct.support_info && currentProduct.quantity && currentProduct.price) {
                products.push(currentProduct);
                currentProduct = {};
            }

            if (!line.includes('Support - DTC') && !line.includes('x') && !line.includes('$')) {
                currentProduct.product_name = line;
            } else if (line.includes('Support - DTC')) {
                currentProduct.support_info = line;
            } else if (line.startsWith('x')) {
                const quantityMatch = line.match(/x(\d+)/);
                currentProduct.quantity = quantityMatch ? quantityMatch[1] : '0';
            } else if (line.startsWith('$')) {
                const priceMatch = line.match(/\$(\d+\.?\d*)/);
                currentProduct.price = priceMatch ? priceMatch[1] : '0';
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

// Process CSV file
function processCsvFile(csvFilePath) {
    try {
        const fileContent = fs.readFileSync(csvFilePath, 'utf-8');
        const lines = fileContent.split('\n');
        return lines
            .filter(line => line.trim())
            .map(line => parseSlackIframeHtml(line));
    } catch (e) {
        console.error(`Error processing CSV file: ${e}`);
        return null;
    }
}

async function waitSeconds(seconds) {
  const milliseconds = seconds * 1000;
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Main function
async function main() {
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Login to Odoo
    await page.goto('https://nilus-ar-test.odoo.com/web/login');

    await waitSeconds(3);
    await page.type('input[name="login"]', 'nilus-tech@nilus.co');
    await page.type('input[name="password"]', 'nilus-tech');
    await clickButton(page, 'button[type="submit"]');
    await waitSeconds(2);
    await page.reload();
    await waitSeconds(3);


    // // Process claims
    // const reclamos = processCsvFile('reclamos.csv');

    const reclamo = {
      order_number: '221717', 
      status: 'anulado', 
      motive: 'dropoff_closed_point',
      products: [], 
      odoo_link: 'https://nilus-ar-test.odoo.com/web#id=4978&cids=1&menu_id=182&action=299&model=sale.order&view_type=form'
    };

    // const reclamo = {
    //     orderNumber: '221717', 
    //     status: 'reembolsado', 
    //     motive: 'None',
    //     products: [
    //         {
    //             productName: 'ACEITE MEZCLA X 900 CC MAROLIO',
    //             supportInfo: 'Support - DTC - Contact - Missing Product',
    //             quantity: '1',
    //             price: '250'
    //         }
    //     ],
    //     odooLink: 'https://nilus-ar-test.odoo.com/web#id=4963&menu_id=182&cids=1&action=299&model=sale.order&view_type=form'
    // };
    

    await page.goto(reclamo.odooLink);
    await waitSeconds(3);

    // Open invoice
    await clickButton(page, '[name="action_view_invoice"]');
    await waitSeconds(1);

    // Click reverse button
    await clickButton(page, '[name="action_reverse"]');
    await waitSeconds(3);

    // Handle modal
    try {
        if (reclamo.status === 'anulado') {
            await page.click('input[type="radio"][data-value="cancel"]');
        } else if (reclamo.status === 'reembolsado') {
            await page.click('input[type="radio"][data-value="refund"]');
        }

        // Select reason
        const inputText = reclamo.status === 'anulado' 
            ? MOTIVOS_ANULADO[reclamo.motive] || 'Sin motivo'
            : reclamo.status === 'reembolsado' && reclamo.products.length > 0
                ? MOTIVOS_REEMBOLSADO[reclamo.products[0].supportInfo] || 'Sin motivo'
                : 'Sin motivo';

        await page.type('td[style="width: 100%;"] input[type="text"]', inputText);
        await page.waitForSelector('a.dropdown-item.ui-menu-item-wrapper');
        const options = await page.$$('a.dropdown-item.ui-menu-item-wrapper');
        for (const option of options) {
            const text = await page.evaluate(el => el.textContent.trim(), option);
            if (text === inputText) {
                await option.click();
                break;
            }
        }

        // // Click revert button
        await clickButton(page, 'button[name="reverse_moves"]');
    } catch (e) {
        console.error(`Error interacting with modal: ${e}`);
    }

    await waitSeconds(5);

    if (reclamo.status === 'reembolsado' && reclamo.products.length > 0) {
        await clickButton(page, 'button.o_form_button_edit');
        await waitSeconds(3);

        const productosReclamo = {};
        for (const p of reclamo.products) {
            productosReclamo[p.productName] = parseInt(p.quantity);
        }

        // Get initial snapshot of rows
        const rows = await page.$$('tbody.ui-sortable tr.o_data_row');
        console.log(rows)
        const filasSnapshot = [];

        // for (const row of rows) {
        //     try {
        //         const nombreProducto = await row.$eval('[name="product_id"]', el => el.textContent.trim());
        //         const cantidadCell = await row.$('td[name="quantity"]');
        //         filasSnapshot.push([nombreProducto, cantidadCell]);
        //     } catch (e) {
        //         console.error(`Could not read a row: ${e}`);
        //     }
        // }

        // // Process each row
        // for (const [nombreProducto, cantidadCell] of filasSnapshot) {
        //     try {
        //         const row = await page.waitForXPath(`//tr[.//*[contains(text(), "${nombreProducto}")]]`);
        //         const cantidadOdoo = parseInt(await cantidadCell.evaluate(el => el.getAttribute('title').replace(',', '.')));

        //         if (nombreProducto in productosReclamo) {
        //             const cantidadReclamo = productosReclamo[nombreProducto];
        //             await cantidadCell.click();
        //             await waitSeconds(2);

        //             try {
        //                 const inputElement = await row.$('input[name="quantity"]');
        //                 await inputElement.evaluate(el => el.value = '');
        //                 await inputElement.type(String(cantidadReclamo));

        //                 await clickButton(page, '.o_form_button_save');
        //                 await clickButton(page, 'button.o_form_button_edit');
        //             } catch (e) {
        //                 console.error(`Could not save ${nombreProducto}: ${e}`);
        //                 continue;
        //             }
        //         } else {
        //             try {
        //                 await waitSeconds(2);
        //                 const deleteButton = await row.$('button.fa.fa-trash-o[name="delete"]');
        //                 await deleteButton.click();
        //                 await waitSeconds(2);
        //             } catch (e) {
        //                 console.error(`Could not delete ${nombreProducto}: ${e}`);
        //                 continue;
        //             }
        //         }
        //     } catch (e) {
        //         console.error(`General error with product ${nombreProducto}: ${e}`);
        //     }
        // }

        // await clickButton(page, '//button[span[text()="Confirmar"]]', 'xpath');
        // await clickButton(page, '(//*[normalize-space(text())="Añadir"])[1]', 'xpath');
    }

    await waitSeconds(1);

    await waitSeconds(50);
    await browser.close();

}

main().catch(console.error);
