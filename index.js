const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parse');
const path = require('path');
const { readSheet } = require('./sheets');

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

function logMessage(message, logs) {
    console.log(message);
    logs.push(message);
}

function processCycleEnd(linea, logs, failed, succeeded) {
    linea.status = failed ? "ERROR" : (succeeded ? "OK" : "Compartidas");
    linea.output = logs.join("\n");
    console.log("linea", linea);
    return wait(5);
}

async function clickButton(page, selector, waitTime = 10000) {
    try {
        await page.waitForSelector(selector, { timeout: waitTime });
        await page.click(selector);
        return true;
    } catch (error) {
        console.log(`🛎️ Error clicking button with selector ${selector}: ${error}`);
        return false;
    }
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

const wait = async (s) => new Promise(resolve => setTimeout(resolve, s*1000));

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
    const posiblesLineas = await readSheet();
    const lineas = posiblesLineas.filter(linea => 
        linea.status === "Compartidas" && 
        linea.output === ""
    );
    if (!lineas) {
        await browser.close();
        return;
    }

    // Login to Odoo
    await page.goto('https://nilus-ar.odoo.com/web/login');

    await wait(4)

    await page.waitForSelector('input[name="login"]');
    await page.type('input[name="login"]', 'nilus-tech@nilus.co');
    await page.type('input[name="password"]', 'nilus-tech');
    await clickButton(page, 'button[type="submit"]');
    await wait(1)

    await page.reload();

    // Process each reclamo
    for (const linea of lineas) {
        const {reclamo, rowId} = linea;
        const logs = []
        let failed = false
        let succeeded = false
        try {
            imprimirReclamo(reclamo);
            logMessage(`Procesando reclamo ${reclamo.order_number}`, logs);
            await page.goto(reclamo.odoo_link);
            await page.reload();
            await wait(10)

            // Check if the page has content
            try {
                const actionManager = await page.waitForSelector('.o_action_manager');
                const children = await actionManager.$$('*');
                if (children.length === 0) {
                    stats.failed_reclamos++;
                    logMessage("🚨 Link invalido. No hay contenido en link de Odoo", logs);
                    failed = true;
                    await processCycleEnd(linea, logs, failed, succeeded);
                    throw new Error("🚨 Link invalido. No hay contenido en link de Odoo");
                }
            } catch (error) {
                stats.failed_reclamos++;
                logMessage("🚨 Link invalido. No hay contenido en link de Odoo", logs);
                failed = true;
                await processCycleEnd(linea, logs, failed, succeeded);
                throw new Error("🚨 Link invalido. No hay contenido en link de Odoo");
            }

            try {
                logMessage("Esperando a que se muestre el botón de facturas", logs);
                const buttonInvoices = await page.waitForSelector('[name="action_view_invoice"]', { visible: true });
                const valueElement = await buttonInvoices.$('span.o_stat_value');
                const valueText = await page.evaluate(el => el.textContent.trim(), valueElement);

                if (valueText === "1") {
                    await clickButton(page, '[name="action_view_invoice"]');
                    await clickButton(page, '[name="action_reverse"]');
                } else {
                    logMessage(`♴ Multiples facturas o ya hay NC. Saltando reclamo: ${reclamo.order_number}`, logs);
                    stats.multiple_invoices++;
                    await processCycleEnd(linea, logs, failed, succeeded);
                    continue;
                }
            } catch (error) {
                // Wait for the first visible one and click it
                const cancelButton = await page.waitForSelector('button[name="action_cancel"]', { visible: true });
                await cancelButton.click();

                // Try to find the modal, but don't throw if it doesn't appear
                const modal = await page.waitForSelector('div.modal-content', { visible: true, timeout: 5000 }).catch(() => null);

                if (modal) {
                    logMessage("✅ Modal encontrado, haciendo clic en Confirmar", logs);
                    try {
                        // Wait for the Confirmar button inside the modal to be visible
                        const confirmButton = await page.waitForSelector('div.modal-content button[name="action_cancel"]', { visible: true });
                        // Click the Confirmar button
                        await confirmButton.click();
                    } catch (modalError) {
                        logMessage("ℹ️ No se pudo interactuar con el modal, continuando...", logs);
                    }
                } else {
                    logMessage("ℹ️ No hay modal porque el pedido ya habia sido confirmado", logs);
                }

                logMessage("✅ No hay factura, cancelando reclamo", logs);
                stats.successful_reclamos++;
                succeeded = true;
                await wait(10)
                await processCycleEnd(linea, logs, failed, succeeded);
                continue;
            }

            // Handle modal
            try {
                await page.waitForSelector('.modal-dialog');

                // Click radio button inside modal
                await page.evaluate((status) => {
                    const modal = document.querySelector('.modal-dialog');
                    if (!modal) return;
                
                    const valueMap = {
                        anulado: 'cancel',        // Reembolso completo
                        reembolsado: 'refund'     // Reembolso parcial
                    };
                
                    const value = valueMap[status];
                    if (!value) return;
                
                    const radio = modal.querySelector(`input[type="radio"][data-value="${value}"]`);
                    if (radio) radio.click();
                }, reclamo.status);
                
                // Determine input text
                const inputText =
                    reclamo.status === 'anulado'
                        ? MOTIVOS_ANULADO[reclamo.motive] || MOTIVOS_ANULADO.customer_canceled
                        : reclamo.products.length > 0
                            ? MOTIVOS_REEMBOLSADO[reclamo.products[0].support_info] || MOTIVOS_REEMBOLSADO['Support - DTC - Contact - Missing Product']
                            : 'Sin motivo';
            
                // Type into the autocomplete input
                await page.type('input.ui-autocomplete-input', inputText);
            
                // Wait for dropdown options and select matching one
                await page.waitForSelector('a.dropdown-item.ui-menu-item-wrapper');
                const options = await page.$$('a.dropdown-item.ui-menu-item-wrapper');
                for (const option of options) {
                    const text = await page.evaluate(el => el.textContent.trim(), option);
                    if (text === inputText) {
                        await option.click();
                        break;
                    }
                }
            
                await wait(4);
            
                // Click the reverse button inside the modal
                await page.evaluate(() => {
                    const modal = document.querySelector('.modal-dialog');
                    if (!modal) return;
            
                    const button = modal.querySelector('button[name="reverse_moves"]');
                    if (button) button.click();
                });
            
                await wait(2);
            
                if (reclamo.status === 'anulado') {
                    logMessage("✅ Anulado con éxito", logs);
                    stats.successful_reclamos++;
                    succeeded = true;
                }
            } catch (error) {
                logMessage(`⚠️ Error al interactuar con el modal: ${error}`, logs);
                stats.failed_reclamos++;
                failed = true;
                await processCycleEnd(linea, logs, failed, succeeded);
                continue;
            }
            

            if (reclamo.status === 'reembolsado' && reclamo.products.length > 0) {
                await wait(3)
                await clickButton(page, 'button.o_form_button_edit');
                await wait(5)

                try {
                    await clickButton(page, 'i.o_optional_columns_dropdown_toggle.fa.fa-ellipsis-v');
                    await clickButton(page, 'input[name="x_studio_id_producto"]');
                    await clickButton(page, 'i.o_optional_columns_dropdown_toggle.fa.fa-ellipsis-v');
                } catch (error) {
                    logMessage(`⚠️ No se pudo hacer clic en el botón de opciones: ${error}`, logs);
                    stats.failed_reclamos++;
                    failed = true;
                    await processCycleEnd(linea, logs, failed, succeeded);
                    continue;
                }

                await wait(4)

                const productosReclamo = {};
                for (const p of reclamo.products) {
                    productosReclamo[p.product_id] = parseInt(p.quantity);
                }

                // Get initial snapshot of rows
                const filasSnapshot = await page.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('tbody.ui-sortable tr.o_data_row'));
                    return rows.map(row => {
                        const cells = row.querySelectorAll('td');
                        return cells[2].textContent.trim();
                    });
                });

                // Process each row
                for (const nombreProducto of filasSnapshot) {
                    try {
                        await wait(2)
                        const rows = await page.$$('tbody.ui-sortable tr.o_data_row');

                        for (const row of rows) {
                            const nombreProductoNuevaTabla = await page.evaluate(el => {
                                const cells = el.querySelectorAll('td');
                                return cells[2].textContent.trim();
                            }, row);


                            if (nombreProductoNuevaTabla === nombreProducto) {
                                if (nombreProducto in productosReclamo) {
                                    logMessage(`Producto ${nombreProducto} en reclamo`, logs);
                                    const cantidadReclamo = productosReclamo[nombreProducto];

                                    await page.evaluate((row) => {
                                        const cell = row.querySelector('td[name="quantity"]');
                                        cell.click();
                                    }, row);

                                    await wait(2)
                                    await page.type('input[name="quantity"]', cantidadReclamo.toString());

                                    try {
                                        await clickButton(page, '.o_form_button_save');
                                        await wait(8)
                                        await page.waitForSelector('button.o_form_button_edit', { visible: true });
                                        await clickButton(page, 'button.o_form_button_edit');
                                        succeeded = true;
                                    } catch (error) {
                                        logMessage(`⚠️ No se pudo guardar ${nombreProducto}: ${error}`, logs);
                                        stats.failed_reclamos++;
                                        failed = true;
                                        await processCycleEnd(linea, logs, failed, succeeded);
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
                                        succeeded = true;
                                    } catch (error) {
                                        logMessage(`⚠️ No se pudo borrar ${nombreProducto}: ${error}`, logs);
                                        stats.failed_reclamos++;
                                        failed = true;
                                        await processCycleEnd(linea, logs, failed, succeeded);
                                        continue;
                                    }
                                }
                                break;
                            }
                        }
                    } catch (error) {
                        logMessage(`⚠️ Error general con el producto ${nombreProducto}: ${error}`, logs);
                        stats.failed_reclamos++;
                        failed = true;
                        await processCycleEnd(linea, logs, failed, succeeded);
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

                logMessage("Esperando a que se actualice la tabla", logs);
                await wait(10)
                await page.waitForSelector('table tbody tr');
                const finalRows = await page.$$('table tbody tr');

                for (const row of finalRows) {
                    const columns = await row.$$('td');
                    if (columns.length === 3) {
                        const invoiceNumber = await page.evaluate(el => el.textContent.trim(), columns[1]);
                        if (invoiceNumber === invoiceId) {
                            logMessage(`Found matching invoice: ${invoiceNumber}`, logs);
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
                                    logMessage("✅ Reembolso parcial exitoso", logs);
                                    succeeded = true;
                                } else {
                                    logMessage("Error: Link with text 'Añadir' not found.", logs);
                                    throw new Error("Link with text 'Añadir' not found.");
                                }
                            } catch (error) {
                                logMessage(`⚠️ Error: 'Añadir' button not found in row: ${error}`, logs);
                                stats.failed_reclamos++;
                                failed = true;
                                await processCycleEnd(linea, logs, failed, succeeded);
                            }
                            break;
                        }
                    }
                }

            }
        } catch (error) {
            logMessage(`⚠️ Error general procesando reclamo: ${error}`, logs);
            stats.failed_reclamos++;
            failed = true;
            await processCycleEnd(linea, logs, failed, succeeded);
            continue;
        }
        await processCycleEnd(linea, logs, failed, succeeded);
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