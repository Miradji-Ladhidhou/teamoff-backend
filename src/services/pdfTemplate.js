// pdfTemplate.js
const PDFDocument = require('pdfkit');

const MAIN_COLOR = '#0d6efd';
const HEADER_HEIGHT = 60;
const FOOTER_HEIGHT = 40;
const PAGE_MARGIN = 40;

const FONT_SIZE_TITLE = 20;
const FONT_SIZE_HEADER = 14;
const FONT_SIZE_META = 10;
const FONT_SIZE_NORMAL = 11;
const FONT_SIZE_TABLE = 10;

const FOOTER_TEXT = 'Document généré automatiquement - TeamOff RH';

// =========================
// HEADER
// =========================
function addHeader(doc, { entreprise, date = new Date() } = {}) {
  doc.save();

  doc.rect(0, 0, doc.page.width, HEADER_HEIGHT).fill(MAIN_COLOR);

  doc.fillColor('white')
    .fontSize(FONT_SIZE_HEADER)
    .font('Helvetica-Bold')
    .text('TEAMOFF RH', PAGE_MARGIN, 18);

  doc.font('Helvetica')
    .fontSize(FONT_SIZE_META);

  if (entreprise) {
    doc.text(entreprise, PAGE_MARGIN, 38);
  }

  doc.text(
    'Généré le : ' + date.toLocaleDateString('fr-FR'),
    -PAGE_MARGIN,
    18,
    { align: 'right' }
  );

  doc.restore();

  doc.moveTo(PAGE_MARGIN, HEADER_HEIGHT - 5)
    .lineTo(doc.page.width - PAGE_MARGIN, HEADER_HEIGHT - 5)
    .lineWidth(1)
    .strokeColor(MAIN_COLOR)
    .stroke();

  doc.y = HEADER_HEIGHT + 10;
}

// =========================
// TITLE
// =========================
function addTitle(doc, title) {
  doc.moveDown(1);

  doc.font('Helvetica-Bold')
    .fontSize(FONT_SIZE_TITLE)
    .fillColor(MAIN_COLOR)
    .text(title, {
      align: 'center'
    });

  doc.moveDown(1);
  doc.fillColor('black')
    .fontSize(FONT_SIZE_NORMAL);
}

// =========================
// SUMMARY
// =========================
function addSummary(doc, { total = 0 }) {
  doc.font('Helvetica-Bold')
    .fontSize(12)
    .text(`Total enregistrements : ${total}`);

  doc.moveDown(0.5);
}

// =========================
// FILTERS
// =========================
function addFilters(doc, filters = {}) {
  const lines = [];

  if (filters.dateDebut || filters.dateFin) {
    lines.push(`Période : ${filters.dateDebut || '...'} → ${filters.dateFin || '...'}`);
  }
  if (filters.statut) lines.push(`Statut : ${filters.statut}`);
  if (filters.service) lines.push(`Service : ${filters.service}`);
  if (filters.utilisateur) lines.push(`Utilisateur : ${filters.utilisateur}`);

  if (!lines.length) return;

  doc.font('Helvetica-Oblique')
    .fontSize(FONT_SIZE_META);

  lines.forEach(line => {
    doc.text(line);
  });

  doc.moveDown(1);
  doc.font('Helvetica')
    .fontSize(FONT_SIZE_NORMAL);
}

// =========================
// TABLE (RESPONSIVE)
// =========================
function normalizeColumns(columns, pageWidth) {
  const total = columns.reduce((sum, col) => sum + (col.width || 1), 0);

  return columns.map(col => ({
    ...col,
    width: ((col.width || 1) / total) * pageWidth
  }));
}

function addTable(doc, columns, rows, options = {}) {
  const { zebra = true, statusColor = false } = options;

  if (!rows.length) {
    doc.moveDown(2);
    doc.font('Helvetica-Oblique')
      .fontSize(12)
      .fillColor('gray')
      .text('Aucune donnée disponible pour ces filtres.', {
        align: 'center'
      });
    return;
  }

  const usableWidth = doc.page.width - PAGE_MARGIN * 2;
  const cols = normalizeColumns(columns, usableWidth);

  const colX = [];
  let x = PAGE_MARGIN;

  cols.forEach(col => {
    colX.push(x);
    x += col.width;
  });

  const rowHeight = 20;

  // HEADER
  doc.save();
  doc.rect(PAGE_MARGIN, doc.y, usableWidth, rowHeight).fill(MAIN_COLOR);

  doc.fillColor('white')
    .font('Helvetica-Bold')
    .fontSize(FONT_SIZE_TABLE);

  cols.forEach((col, i) => {
    doc.text(col.label, colX[i] + 4, doc.y + 5, {
      width: col.width - 8
    });
  });

  doc.restore();
  doc.y += rowHeight;

  // ROWS
  let rowIndex = 0;

  rows.forEach(row => {
    // pagination
    if (doc.y + rowHeight + FOOTER_HEIGHT > doc.page.height) {
      doc.addPage();
      addHeader(doc, {});
      doc.moveDown();
    }

    // zebra
    if (zebra && rowIndex % 2 === 1) {
      doc.save();
      doc.rect(PAGE_MARGIN, doc.y, usableWidth, rowHeight).fill('#f4f6f8');
      doc.restore();
    }

    cols.forEach((col, i) => {
      let value = row[col.key] ?? '';
      value = String(value);

      if (value.length > 40) {
        value = value.slice(0, 37) + '...';
      }

      if (statusColor && col.key === 'statut') {
        if (value.toLowerCase().includes('approuv')) doc.fillColor('#198754');
        else if (value.toLowerCase().includes('refus')) doc.fillColor('#dc3545');
        else doc.fillColor('black');
      } else {
        doc.fillColor('black');
      }

      doc.font('Helvetica')
        .fontSize(FONT_SIZE_TABLE)
        .text(value, colX[i] + 4, doc.y + 5, {
          width: col.width - 8
        });
    });

    doc.y += rowHeight;
    rowIndex++;
  });

  doc.moveDown(1);
}

// =========================
// FOOTER (FIX CRASH)
// =========================
function addFooter(doc) {
  const range = doc.bufferedPageRange();
  const total = range.count;

  if (!total) return;

  for (let i = 0; i < total; i++) {
    const pageIndex = range.start + i;

    try {
      doc.switchToPage(pageIndex);
    } catch (err) {
      continue; // sécurité
    }

    doc.font('Helvetica-Oblique')
      .fontSize(FONT_SIZE_META)
      .fillColor('gray');

    doc.text(
      FOOTER_TEXT,
      PAGE_MARGIN,
      doc.page.height - FOOTER_HEIGHT + 10
    );

    doc.text(
      `Page ${i + 1} / ${total}`,
      -PAGE_MARGIN,
      doc.page.height - FOOTER_HEIGHT + 10,
      { align: 'right' }
    );
  }
}

// =========================
module.exports = {
  addHeader,
  addTitle,
  addSummary,
  addFilters,
  addTable,
  addFooter,
  MAIN_COLOR,
  PAGE_MARGIN
};