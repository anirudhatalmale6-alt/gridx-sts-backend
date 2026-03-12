const PDFDocument = require('pdfkit');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Helper — format currency as N$ xxx.xx
// ---------------------------------------------------------------------------
function currency(amount) {
  return `N$ ${parseFloat(amount || 0).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Helper — format token with dashes: XXXX-XXXX-XXXX-XXXX-XXXX
// ---------------------------------------------------------------------------
function formatToken(token) {
  if (!token) return '--------------------';
  // If already formatted, return as-is
  if (token.includes('-')) return token;
  return token.replace(/(.{4})/g, '$1-').slice(0, 24);
}

// ===========================================================================
// generateReceipt — Full-size PDF receipt (A4/Letter)
// ===========================================================================
async function generateReceipt(transactionData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Receipt - ${transactionData.reference || 'N/A'}`,
          Author: 'GRIDx Smart Metering Platform',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const breakdown = transactionData.breakdown || {};
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // ----- Header -----
      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .text('GRIDx / Pulsar Electronic Solutions', { align: 'center' });

      doc.moveDown(0.3);

      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text('ELECTRICITY TOKEN RECEIPT', { align: 'center' });

      doc.moveDown(0.5);

      // ----- NamPower Logo Placeholder -----
      doc
        .rect(doc.page.margins.left + pageWidth / 2 - 60, doc.y, 120, 30)
        .stroke('#cccccc');
      doc
        .fontSize(8)
        .font('Helvetica')
        .text('NamPower Logo', doc.page.margins.left + pageWidth / 2 - 60, doc.y + 10, {
          width: 120,
          align: 'center',
        });

      doc.y += 40;
      doc.moveDown(0.5);

      // ----- Divider -----
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.margins.left + pageWidth, doc.y)
        .stroke('#333333');
      doc.moveDown(0.5);

      // ----- Receipt Details -----
      const leftCol = doc.page.margins.left;
      const rightCol = doc.page.margins.left + 200;

      function detailRow(label, value) {
        const y = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text(label, leftCol, y);
        doc.fontSize(10).font('Helvetica').text(value || 'N/A', rightCol, y);
        doc.moveDown(0.4);
      }

      const txnDate = transactionData.created_at
        ? new Date(transactionData.created_at).toLocaleString('en-NA', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })
        : new Date().toLocaleString('en-NA', { dateStyle: 'medium', timeStyle: 'short' });

      detailRow('Date/Time:', txnDate);
      detailRow('Receipt No:', transactionData.reference || 'N/A');
      detailRow('Transaction Ref:', transactionData.reference || 'N/A');
      detailRow('Customer Name:', transactionData.customerName || transactionData.customer_name || 'N/A');
      detailRow('Account No:', transactionData.accountNo || transactionData.account_no || 'N/A');
      detailRow('Meter No:', transactionData.meterNo || transactionData.meter_no || 'N/A');
      detailRow('Area:', transactionData.area || 'N/A');

      doc.moveDown(0.5);

      // ----- Divider -----
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.margins.left + pageWidth, doc.y)
        .stroke('#333333');
      doc.moveDown(0.5);

      // ----- Amount Tendered -----
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(`Amount Tendered: ${currency(breakdown.amountTendered || transactionData.amount)}`, {
          align: 'left',
        });
      doc.moveDown(0.5);

      // ----- Breakdown Table -----
      doc.fontSize(11).font('Helvetica-Bold').text('Breakdown', { underline: true });
      doc.moveDown(0.3);

      const fixedCharge = parseFloat(breakdown.fixedCharge || 8.50);
      const relLevy = parseFloat(breakdown.relLevy || 2.40);
      const vatRate = 15;
      const vatAmount = parseFloat(breakdown.vat || 0);
      const arrearsDeduction = parseFloat(breakdown.arrearsDeduction || 0);
      const electricityAmount = parseFloat(breakdown.electricityAmount || 0);

      function breakdownRow(label, value) {
        const y = doc.y;
        doc.fontSize(10).font('Helvetica').text(label, leftCol, y);
        doc.fontSize(10).font('Helvetica').text(value, leftCol + pageWidth - 100, y, {
          width: 100,
          align: 'right',
        });
        doc.moveDown(0.35);
      }

      breakdownRow('Fixed Charge:', currency(fixedCharge));
      breakdownRow('REL Levy:', currency(relLevy));
      breakdownRow(`VAT (${vatRate}%):`, currency(vatAmount));
      breakdownRow('Arrears Deduction:', currency(arrearsDeduction));

      // Electricity amount line (bold)
      const elecY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').text('Electricity Amount:', leftCol, elecY);
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(currency(electricityAmount), leftCol + pageWidth - 100, elecY, {
          width: 100,
          align: 'right',
        });
      doc.moveDown(0.5);

      // ----- Divider -----
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.margins.left + pageWidth, doc.y)
        .stroke('#333333');
      doc.moveDown(0.5);

      // ----- kWh and Tariff -----
      detailRow('kWh Purchased:', `${parseFloat(transactionData.kwh || 0).toFixed(2)} kWh`);
      detailRow('Tariff Group:', transactionData.tariffGroup || transactionData.tariff_group || 'N/A');

      doc.moveDown(0.8);

      // ----- TOKEN (large, bold, centered) -----
      doc
        .rect(doc.page.margins.left, doc.y, pageWidth, 50)
        .fillAndStroke('#f0f0f0', '#333333');

      doc.moveDown(0.2);

      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .fillColor('#000000')
        .text(`TOKEN: ${formatToken(transactionData.token)}`, doc.page.margins.left, doc.y, {
          width: pageWidth,
          align: 'center',
        });

      doc.moveDown(1.5);

      // ----- Footer -----
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor('#333333')
        .text('Keep this receipt safe. Token valid for 90 days.', { align: 'center' });

      doc.moveDown(0.5);

      // Vendor and operator info
      if (transactionData.vendorName || transactionData.vendor_name) {
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(`Vendor: ${transactionData.vendorName || transactionData.vendor_name}`, { align: 'center' });
      }
      if (transactionData.operatorName || transactionData.operator_name) {
        doc
          .fontSize(9)
          .font('Helvetica')
          .text(`Operator: ${transactionData.operatorName || transactionData.operator_name}`, { align: 'center' });
      }

      doc.moveDown(1);

      // Small print
      doc
        .fontSize(7)
        .font('Helvetica')
        .fillColor('#888888')
        .text('Powered by GRIDx Smart Metering Platform', { align: 'center' });

      doc.end();
    } catch (err) {
      logger.error('generateReceipt failed', { error: err.message, stack: err.stack });
      reject(err);
    }
  });
}

// ===========================================================================
// generateThermalReceipt — 80mm thermal printer format (~48 chars per line)
// ===========================================================================
async function generateThermalReceipt(transactionData) {
  return new Promise((resolve, reject) => {
    try {
      // 80mm thermal paper is approximately 200pt (72mm printable)
      const paperWidth = 200;
      const margin = 10;

      const doc = new PDFDocument({
        size: [paperWidth, 600], // width fixed, height will auto-extend
        margin,
        info: {
          Title: `Thermal Receipt - ${transactionData.reference || 'N/A'}`,
          Author: 'GRIDx Smart Metering Platform',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const breakdown = transactionData.breakdown || {};
      const contentWidth = paperWidth - margin * 2;
      const charWidth = 48; // approximate chars for 80mm

      function separator() {
        doc.fontSize(6).font('Courier').text('-'.repeat(charWidth), { align: 'center' });
        doc.moveDown(0.2);
      }

      function centerText(text, size = 7, bold = false) {
        doc
          .fontSize(size)
          .font(bold ? 'Courier-Bold' : 'Courier')
          .text(text, { align: 'center', width: contentWidth });
        doc.moveDown(0.15);
      }

      function leftRight(left, right) {
        const y = doc.y;
        const halfWidth = contentWidth / 2;
        doc.fontSize(6).font('Courier').text(left, margin, y, { width: halfWidth, align: 'left' });
        doc.fontSize(6).font('Courier').text(right, margin + halfWidth, y, { width: halfWidth, align: 'right' });
        doc.moveDown(0.25);
      }

      // ----- Header -----
      centerText('GRIDx / Pulsar Electronic', 8, true);
      centerText('Solutions', 8, true);
      doc.moveDown(0.1);
      centerText('ELECTRICITY TOKEN RECEIPT', 7, true);
      doc.moveDown(0.1);

      separator();

      // ----- Receipt Details -----
      const txnDate = transactionData.created_at
        ? new Date(transactionData.created_at).toLocaleString('en-NA', {
            dateStyle: 'short',
            timeStyle: 'short',
          })
        : new Date().toLocaleString('en-NA', { dateStyle: 'short', timeStyle: 'short' });

      leftRight('Date/Time:', txnDate);
      leftRight('Receipt No:', transactionData.reference || 'N/A');
      leftRight('Customer:', (transactionData.customerName || transactionData.customer_name || 'N/A').substring(0, 20));
      leftRight('Account:', transactionData.accountNo || transactionData.account_no || 'N/A');
      leftRight('Meter No:', transactionData.meterNo || transactionData.meter_no || 'N/A');
      leftRight('Area:', (transactionData.area || 'N/A').substring(0, 20));

      separator();

      // ----- Amount Tendered -----
      leftRight('Amt Tendered:', currency(breakdown.amountTendered || transactionData.amount));
      doc.moveDown(0.1);

      // ----- Breakdown -----
      const fixedCharge = parseFloat(breakdown.fixedCharge || 8.50);
      const relLevy = parseFloat(breakdown.relLevy || 2.40);
      const vatAmount = parseFloat(breakdown.vat || 0);
      const arrearsDeduction = parseFloat(breakdown.arrearsDeduction || 0);
      const electricityAmount = parseFloat(breakdown.electricityAmount || 0);

      leftRight('Fixed Charge:', currency(fixedCharge));
      leftRight('REL Levy:', currency(relLevy));
      leftRight('VAT (15%):', currency(vatAmount));
      leftRight('Arrears Ded.:', currency(arrearsDeduction));
      leftRight('Elec Amount:', currency(electricityAmount));

      separator();

      // ----- kWh and Tariff -----
      leftRight('kWh Purchased:', `${parseFloat(transactionData.kwh || 0).toFixed(2)}`);
      leftRight('Tariff:', transactionData.tariffGroup || transactionData.tariff_group || 'N/A');

      separator();

      // ----- TOKEN (centered, bold) -----
      doc.moveDown(0.2);
      centerText('TOKEN:', 8, true);
      centerText(formatToken(transactionData.token), 9, true);
      doc.moveDown(0.2);

      separator();

      // ----- Footer -----
      centerText('Keep this receipt safe.', 6, false);
      centerText('Token valid for 90 days.', 6, false);
      doc.moveDown(0.2);

      if (transactionData.vendorName || transactionData.vendor_name) {
        centerText(`Vendor: ${transactionData.vendorName || transactionData.vendor_name}`, 6);
      }
      if (transactionData.operatorName || transactionData.operator_name) {
        centerText(`Operator: ${transactionData.operatorName || transactionData.operator_name}`, 6);
      }

      doc.moveDown(0.3);
      centerText('Powered by GRIDx Smart', 5, false);
      centerText('Metering Platform', 5, false);

      doc.end();
    } catch (err) {
      logger.error('generateThermalReceipt failed', { error: err.message, stack: err.stack });
      reject(err);
    }
  });
}

module.exports = {
  generateReceipt,
  generateThermalReceipt,
};
