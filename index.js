const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parse');
const path = require('path');
const { readSheet } = require('./sheets');
const { loginToOdoo, wait, clickButton, navigateToReclamo } = require('./functions');

// Initialize counters and error tracking
const stats = {
    total_reclamos: 0,
    successful_reclamos: 0,
    failed_reclamos: 0,
    multiple_invoices: 0
};

const MOTIVOS_ANULADO = {
    'dropoff_closed_point': 'Baja del punto de entrega',
    'unresponsive_customer': 'Cliente cancela post-corte',
    'client_cancelled_after_cutoff': 'Cliente cancela post-corte',
    'customer_canceled': 'Cliente cancela post-corte',
    'fraudulent_customer': 'Cliente fraudulento',
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
                const quantityMatch = line.match(/x(\d+(?:\.\d+)?)/);
                currentProduct.quantity = quantityMatch ? quantityMatch[1].replace('.', ',') : "0";
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

async function processCsvFile(csvFilePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(csvFilePath)
            .pipe(csv.parse())
            .on('data', (row) => {
                if (row.length > 0) {
                    const htmlContent = row[0];
                    const parsedData = parseSlackIframeHtml(htmlContent);
                    results.push(parsedData);
                }
            })
            .on('end', () => resolve(results))
            .on('error', (error) => reject(error));
    });
}

function imprimirReclamo(reclamo) {
    stats.total_reclamos++;
    const order = reclamo.order_number || 'N/A';
    const status = reclamo.status.toLowerCase();
    const link = reclamo.odoo_link || 'Sin link';
    console.log("-".repeat(66));

    if (status === 'anulado') {
        const motivo = MOTIVOS_ANULADO[reclamo.motive] || MOTIVOS_ANULADO.customer_canceled;
        console.log(`🛑 Pedido ${order} fue ANULADO por: ${motivo}`);
    } else if (status === 'reembolsado') {
        console.log(`💸 Pedido ${order} fue REEMBOLSADO por los siguientes productos:`);
        for (const producto of reclamo.products) {
            const supportInfo = producto.support_info || '';
            const motivo = MOTIVOS_REEMBOLSADO[supportInfo] || MOTIVOS_REEMBOLSADO['Support - DTC - Contact - Missing Product'];
            const nombre = producto.product_name || 'Producto sin nombre';
            const cantidad = producto.quantity || '?';
            const precio = producto.price || '?';
            console.log(`   • ${cantidad} x ${nombre} ($${precio}) → Motivo: ${motivo}`);
        }
    } else {
        console.log(`⚠️ Pedido ${order} tiene un estado desconocido: ${status}`);
    }

    console.log(`🔗 Ver en Odoo: ${link}`);
}

async function findAndProcessCsvFile() {
    // Find CSV file
    const folderPath = path.join(__dirname);
    const csvFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.csv'));

    if (csvFiles.length === 0) {
        console.log("❌ No se encontraron archivos CSV en el directorio");
        return null;
    }

    const csvFile = path.join(folderPath, csvFiles[0]);
    const reclamos = await processCsvFile(csvFile);
    console.log(`📊 Total de reclamos a procesar: ${reclamos.length}`);
    return reclamos;
}

async function main() {
    let HEADLESS = false;
    HEADLESS = "new"; 

    const browser = await puppeteer.launch({
        headless: HEADLESS,
    });

    const page = await browser.newPage();
    await page.setViewport({
        width: 1920,
        height: 1080
    });
    if (!HEADLESS) {
        await page.evaluate(() => {
            return document.documentElement.requestFullscreen();
        });
    }

    // Get reclamos from CSV
    const reclamos = await findAndProcessCsvFile();
    if (!reclamos) {
        await browser.close();
        return;
    }

    // Login to Odoo
    await loginToOdoo(page);

    let columnsSelected = false;

    // Process each reclamo
    for (const reclamo of reclamos) {
        try {
            await navigateToReclamo(page, reclamo);

            // Check if the page has content
            try {
                const actionManager = await page.waitForSelector('.o_action_manager');
                const children = await actionManager.$$('*');
                if (children.length === 0) {
                    stats.failed_reclamos++;
                    throw new Error("🚨 Link invalido. No hay contenido en link de Odoo");
                }
            } catch (error) {
                stats.failed_reclamos++;
                throw new Error("🚨 Link invalido. No hay contenido en link de Odoo");
            }

            try {
                console.log("Esperando a que se muestre el botón de facturas");
                const buttonInvoices = await page.waitForSelector('[name="action_view_invoice"]', { visible: true });
                const valueElement = await buttonInvoices.$('span.o_stat_value');
                const valueText = await page.evaluate(el => el.textContent.trim(), valueElement);

                if (valueText === "1") {
                    await clickButton(page, '[name="action_view_invoice"]');
                    await clickButton(page, '[name="action_reverse"]');
                } else {
                    console.log(`♴ Multiples facturas o ya hay NC. Saltando reclamo: ${reclamo.order_number}`);
                    stats.multiple_invoices++;
                    continue;
                }
            } catch (error) {
                // Wait for the first visible one and click it
                const cancelButton = await page.waitForSelector('button[name="action_cancel"]', { visible: true });
                await cancelButton.click();

                // Try to find the modal, but don't throw if it doesn't appear
                const modal = await page.waitForSelector('div.modal-content', { visible: true, timeout: 5000 }).catch(() => null);

                if (modal) {
                    console.log("✅ Modal encontrado, haciendo clic en Confirmar");
                    try {
                        // Wait for the Confirmar button inside the modal to be visible
                        const confirmButton = await page.waitForSelector('div.modal-content button[name="action_cancel"]', { visible: true });
                        // Click the Confirmar button
                        await confirmButton.click();
                    } catch (modalError) {
                        console.log("ℹ️ No se pudo interactuar con el modal, continuando...");
                    }
                } else {
                    console.log("ℹ️ No hay modal porque el pedido ya habia sido confirmado");
                }

                console.log("✅ No hay factura, cancelando reclamo");
                stats.successful_reclamos++;
                await wait(20);
                continue;
            }

            // Handle modal
            try {
                await page.waitForSelector('.modal-dialog');

                // Click radio button inside modal
                const modalResult = await page.evaluate((status) => {
                    const modal = document.querySelector('.modal-dialog');
                    if (!modal) {
                        console.log("❌ No se encontró el modal");
                        return { success: false, error: "Modal no encontrado" };
                    }
                
                    const valueMap = {
                        anulado: 'cancel',        // Reembolso completo
                        reembolsado: 'refund'     // Reembolso parcial
                    };
                
                    const value = valueMap[status];
                    if (!value) {
                        console.log(`❌ Estado no válido: ${status}`);
                        return { success: false, error: "Estado no válido" };
                    }
                
                    const radio = modal.querySelector(`input[type="radio"][data-value="${value}"]`);
                    if (!radio) {
                        console.log(`❌ No se encontró el radio button para ${value}`);
                        return { success: false, error: "Radio button no encontrado" };
                    }
                    
                    radio.click();
                    return { success: true };
                }, reclamo.status);

                if (!modalResult.success) {
                    console.log(`⚠️ Error en el modal: ${modalResult.error}`);
                    stats.failed_reclamos++;
                    continue;
                }
                
                // Determine input text
                const inputText =
                    reclamo.status === 'anulado'
                        ? MOTIVOS_ANULADO[reclamo.motive] || MOTIVOS_ANULADO.customer_canceled
                        : reclamo.products.length > 0
                            ? MOTIVOS_REEMBOLSADO[reclamo.products[0].support_info] || MOTIVOS_REEMBOLSADO['Support - DTC - Contact - Missing Product']
                            : 'Sin motivo';
            
                console.log(`📝 Intentando escribir motivo: ${inputText}`);
                // Type into the autocomplete input
                await page.type('input.ui-autocomplete-input', inputText);
            
                // Wait for dropdown options and select matching one
                try {
                    await page.waitForSelector('a.dropdown-item.ui-menu-item-wrapper', { timeout: 5000 });
                    const options = await page.$$('a.dropdown-item.ui-menu-item-wrapper');
                    let optionFound = false;
                    
                    for (const option of options) {
                        const text = await page.evaluate(el => el.textContent.trim(), option);
                        if (text === inputText) {
                            await option.click();
                            optionFound = true;
                            break;
                        }
                    }
                    
                    if (!optionFound) {
                        console.log(`⚠️ No se encontró la opción exacta para: ${inputText}`);
                        // Click the first option as fallback
                        if (options.length > 0) {
                            await options[0].click();
                            console.log("✅ Se seleccionó la primera opción disponible");
                        } else {
                            throw new Error("No hay opciones disponibles en el dropdown");
                        }
                    }
                } catch (error) {
                    console.log(`⚠️ Error al seleccionar opción del dropdown: ${error}`);
                    stats.failed_reclamos++;
                    continue;
                }
            
                await wait(4);
            
                // Click the reverse button inside the modal
                const reverseResult = await page.evaluate(() => {
                    const modal = document.querySelector('.modal-dialog');
                    if (!modal) {
                        console.log("❌ Modal desapareció antes de hacer clic en reverse");
                        return { success: false, error: "Modal no encontrado" };
                    }
            
                    const button = modal.querySelector('button[name="reverse_moves"]');
                    if (!button) {
                        console.log("❌ No se encontró el botón reverse_moves");
                        return { success: false, error: "Botón no encontrado" };
                    }
                    
                    button.click();
                    return { success: true };
                });

                if (!reverseResult.success) {
                    console.log(`⚠️ Error al hacer clic en reverse: ${reverseResult.error}`);
                    stats.failed_reclamos++;
                    continue;
                }
            
                await wait(2);
            
                if (reclamo.status === 'anulado') {
                    console.log("✅ Anulado con éxito");
                    stats.successful_reclamos++;
                }
            } catch (error) {
                console.log(`⚠️ Error al interactuar con el modal: ${error}`);
                stats.failed_reclamos++;
                continue;
            }
            
            if (reclamo.status === 'reembolsado' && reclamo.products.length > 0) {
                await wait(3)
                await clickButton(page, 'button.o_form_button_edit');
                await wait(5)

                try {
                    if (!columnsSelected) {
                        await clickButton(page, 'i.o_optional_columns_dropdown_toggle.fa.fa-ellipsis-v');
                        await clickButton(page, 'input[name="x_studio_id_producto"]');
                        await clickButton(page, 'i.o_optional_columns_dropdown_toggle.fa.fa-ellipsis-v');
                        columnsSelected = true;
                    }
                } catch (error) {
                    console.log(`⚠️ No se pudo hacer clic en el botón de opciones: ${error}`);
                    stats.failed_reclamos++;
                    continue;
                }

                await wait(4)

                const productosReclamo = {};
                for (const p of reclamo.products) {
                    productosReclamo[p.product_id] = p.quantity;
                }
                console.log("Productos a reembolsar:", productosReclamo);

                // Get initial snapshot of rows
                const filasSnapshot = await page.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('tbody.ui-sortable tr.o_data_row'));
                    return rows.map(row => {
                        const cells = row.querySelectorAll('td');
                        const productId = cells[2].textContent.trim();
                        if (productId === "116") {
                            console.log("Bonificacion encontrada");
                        }
                        return productId;
                    });
                });
                console.log("Productos encontrados en la tabla:", filasSnapshot);

                // Process each row
                for (const productId of filasSnapshot) {
                    try {
                        await wait(2)
                        const rows = await page.$$('tbody.ui-sortable tr.o_data_row');

                        for (const row of rows) {
                            const currentProductId = await page.evaluate(el => {
                                const cells = el.querySelectorAll('td');
                                const text = cells[2].textContent.trim();
                                return text;
                            }, row);
                            if (currentProductId === productId) {
                                if (productId in productosReclamo) {
                                    console.log(`Producto ${productId} en reclamo con cantidad ${productosReclamo[productId]}`);
                                    const cantidadReclamo = productosReclamo[productId];

                                    await page.evaluate((row) => {
                                        const cell = row.querySelector('td[name="quantity"]');
                                        cell.click();
                                    }, row);

                                    await wait(2)
                                    await page.type('input[name="quantity"]', cantidadReclamo.toString());

                                    try {
                                        await clickButton(page, '.o_form_button_save');
                                        await wait(12)
                                        await page.waitForSelector('button.o_form_button_edit', { visible: true });
                                        await clickButton(page, 'button.o_form_button_edit');
                                    } catch (error) {
                                        console.log(`⚠️ No se pudo guardar ${productId}: ${error}`);
                                        stats.failed_reclamos++;
                                        continue;
                                    }
                                } else {
                                    try {
                                        await wait(2)
                                        await page.evaluate((row) => {
                                            const button = row.querySelector('button.fa.fa-trash-o[name="delete"]');
                                            if (button) button.click();
                                        }, row);
                                        await wait(2)
                                    } catch (error) {
                                        console.log(`⚠️ No se pudo borrar ${productId}: ${error}`);
                                        stats.failed_reclamos++;
                                        continue;
                                    }
                                }
                                break;
                            }
                        }
                    } catch (error) {
                        console.log(`⚠️ Error general con el producto ${productId}: ${error}`);
                        stats.failed_reclamos++;
                        continue;
                    }
                }
                // Confirm changes
                await wait(2)
                // Check how many buttons match
                await page.evaluate(() => {
                    const buttons = [...document.querySelectorAll('button[name="action_post"]')];
                    const confirmButton = buttons.find(btn => btn.textContent.trim() === 'Confirmar');
                    if (confirmButton) confirmButton.click();
                });
                await wait(5)

                const invoiceElement = await page.$('ol.breadcrumb li.breadcrumb-item.o_back_button a');
                const invoiceId = await page.evaluate(el => el.textContent.trim(), invoiceElement);

                console.log("Esperando a que se actualice la tabla");
                await wait(10)
                await page.waitForSelector('table tbody tr');
                const finalRows = await page.$$('table tbody tr');

                for (const row of finalRows) {
                    const columns = await row.$$('td');
                    if (columns.length === 3) {
                        const invoiceNumber = await page.evaluate(el => el.textContent.trim(), columns[1]);
                        if (invoiceNumber === invoiceId) {
                            console.log(`Found matching invoice: ${invoiceNumber}`);
                            try {
                                // Find the <a> tag in the row whose innerText is "Añadir"
                                const links = await row.$$('a');
                                let addButton = null;
                                for (const link of links) {
                                    const linkText = await page.evaluate(el => el.textContent.trim(), link);
                                    if (linkText === 'Añadir') {
                                        addButton = link;
                                        break;
                                    }
                                }

                                if (addButton) {
                                    await addButton.click();
                                    stats.successful_reclamos++;
                                    console.log("✅ Reembolso parcial exitoso");
                                } else {
                                    throw new Error("Link with text 'Añadir' not found.");
                                }
                            } catch (error) {
                                console.error("⚠️ Error: 'Añadir' button not found in row:", error);
                                stats.failed_reclamos++;
                            }
                            break;
                        }
                    }
                }

            }

        } catch (error) {
            console.log(`⚠️ Error general procesando reclamo: ${error}`);
            stats.failed_reclamos++;
            continue;
        }

        await wait(10)
    }

    console.log("\n" + "=".repeat(50));
    console.log("📊 ESTADÍSTICAS FINALES:");
    console.log("=".repeat(50));
    console.log(`Total de reclamos procesados: ${stats.total_reclamos}`);
    console.log(`✅ Reclamos exitosos: ${stats.successful_reclamos}`);
    console.log(`❌ Reclamos fallidos: ${stats.failed_reclamos}`);
    console.log(`📄 Reclamos con múltiples facturas: ${stats.multiple_invoices}`);
    console.log("=".repeat(50));

    await new Promise(r => setTimeout(r, 50000));
    await browser.close();
}

main().catch(console.error); 