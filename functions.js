const puppeteer = require('puppeteer');

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

const wait = async (s) => new Promise(resolve => setTimeout(resolve, s*1000));

function imprimirReclamo(reclamo) {
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

async function loginToOdoo(page) {
    await page.goto('https://nilus-ar.odoo.com/web/login');
    await wait(4);

    await page.waitForSelector('input[name="login"]');
    await page.type('input[name="login"]', 'nilus-tech@nilus.co');
    await page.type('input[name="password"]', 'nilus-tech');
    await clickButton(page, 'button[type="submit"]');
    await wait(1);

    await page.reload();
}

async function navigateToReclamo(page, reclamo) {
    imprimirReclamo(reclamo);
    await page.goto(reclamo.odoo_link);
    await page.reload();
    await wait(10);
}

module.exports = {
    loginToOdoo,
    wait,
    clickButton,
    navigateToReclamo,
    imprimirReclamo
}; 